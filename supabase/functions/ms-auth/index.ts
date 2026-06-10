import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const GRAPH_SCOPES = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.ReadBasic https://graph.microsoft.com/User.Read https://graph.microsoft.com/User.ReadBasic.All offline_access'

interface OAuthConfig {
  clientId: string
  clientSecret: string
  tenantId: string
  authorityHost: string
  source: "user" | "tenant" | "environment" | "none"
}

/**
 * 3-tier lookup: per-user -> per-tenant -> env.
 * Inlined here to avoid cross-function import map dependencies.
 */
async function getOAuthConfig(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<OAuthConfig | null> {
  const { data: row, error: rpcErr } = await supabase.rpc("get_effective_azure_config", {
    p_user_id: userId,
  })

  if (!rpcErr && row && row.length > 0 && row[0].client_id) {
    let secret = ""
    if (row[0].source === "user") {
      const { data: ul } = await supabase
        .from("user_ms_graph_links")
        .select("ms_client_secret")
        .eq("user_id", userId)
        .maybeSingle()
      secret = ul?.ms_client_secret ?? ""
    } else {
      const { data: m } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userId)
        .maybeSingle()
      if (m?.tenant_id) {
        const { data: t } = await supabase
          .from("tenants")
          .select("ms_client_secret")
          .eq("id", m.tenant_id)
          .maybeSingle()
        secret = t?.ms_client_secret ?? ""
      }
    }
    return {
      clientId: row[0].client_id,
      clientSecret: secret,
      tenantId: row[0].microsoft_tenant_id,
      authorityHost: row[0].authority_host || "https://login.microsoftonline.com",
      source: row[0].source as "user" | "tenant",
    }
  }

  const envClientId = Deno.env.get("MS_CLIENT_ID")
  const envClientSecret = Deno.env.get("MS_CLIENT_SECRET")
  const envTenantId = Deno.env.get("MS_TENANT_ID")
  if (envClientId && envClientSecret && envTenantId) {
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      tenantId: envTenantId,
      authorityHost: Deno.env.get("MS_AUTHORITY_HOST") || "https://login.microsoftonline.com",
      source: "environment",
    }
  }

  return null
}

async function generatePKCE() {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32))
  const verifier = Array.from(verifierBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest('SHA-256', data)
  const challenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { verifier, challenge }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  const url = new URL(req.url)
  const path = url.pathname
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    if (path.endsWith('/authorize') || path === '/ms-auth') {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
      if (userError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      const userId = user.id
      const oauthConfig = await getOAuthConfig(supabase, userId)
      if (!oauthConfig) {
        return new Response(JSON.stringify({
          error: 'Microsoft OAuth not configured. Please ask your admin to set the Azure AD app for your account, your tenant, or set MS_CLIENT_ID/MS_CLIENT_SECRET/MS_TENANT_ID in environment variables.',
          code: 'oauth_not_configured'
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      const { verifier, challenge } = await generatePKCE()
      await supabase
        .from('user_ms_graph_links')
        .upsert({
          user_id: userId,
          code_verifier: verifier,
          status: 'active',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })

      const callbackUrl = `${supabaseUrl}/functions/v1/ms-auth/callback`
      const authUrl = new URL(`${oauthConfig.authorityHost}/${oauthConfig.tenantId}/oauth2/v2.0/authorize`)
      authUrl.searchParams.set('client_id', oauthConfig.clientId)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('redirect_uri', callbackUrl)
      authUrl.searchParams.set('scope', GRAPH_SCOPES)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('response_mode', 'query')
      authUrl.searchParams.set('state', userId)

      console.log(`[ms-auth/authorize] user=${userId} source=${oauthConfig.source} tenant=${oauthConfig.tenantId}`)

      return new Response(JSON.stringify({
        authorization_url: authUrl.toString(),
        config_source: oauthConfig.source,
        message: 'Redirect the user to this URL to start the OAuth flow'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (path.endsWith('/callback')) {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        console.error(`[ms-auth/callback] OAuth error: ${error} - ${errorDescription}`)
        const frontendUrl = Deno.env.get('FRONTEND_URL') || supabaseUrl
        return Response.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(errorDescription || error)}`)
      }
      if (!code || !state) {
        return new Response(JSON.stringify({ error: 'Missing code or state parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        })
      }
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      if (!uuidRe.test(state)) {
        return new Response(JSON.stringify({ error: 'Invalid state parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        })
      }
      const userId = state
      const { data: linkData } = await supabase
        .from('user_ms_graph_links')
        .select('code_verifier')
        .eq('user_id', userId)
        .maybeSingle()
      if (!linkData?.code_verifier) {
        return new Response(JSON.stringify({ error: 'No PKCE verifier found - please restart the OAuth flow' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        })
      }
      const oauthConfig = await getOAuthConfig(supabase, userId)
      if (!oauthConfig) {
        return new Response(JSON.stringify({ error: 'OAuth not configured for this user' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        })
      }
      const callbackUrl = `${supabaseUrl}/functions/v1/ms-auth/callback`
      const tokenBody = new URLSearchParams({
        client_id: oauthConfig.clientId,
        client_secret: oauthConfig.clientSecret,
        code: code,
        redirect_uri: callbackUrl,
        grant_type: 'authorization_code',
        code_verifier: linkData.code_verifier,
        scope: GRAPH_SCOPES,
      })
      const tokenResp = await fetch(
        `${oauthConfig.authorityHost}/${oauthConfig.tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
        }
      )
      const tokens = await tokenResp.json()
      if (!tokenResp.ok) {
        console.error(`[ms-auth/callback] Token exchange failed: ${tokens.error} - ${tokens.error_description}`)
        const frontendUrl = Deno.env.get('FRONTEND_URL') || supabaseUrl
        return Response.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(tokens.error_description || tokens.error)}`)
      }
      const expiresInSec = tokens.expires_in || 3600
      const expiresAt = new Date(Date.now() + (expiresInSec - 300) * 1000).toISOString()
      const { error: storeError } = await supabase.rpc('store_ms_graph_access_token', {
        p_user_id: userId,
        p_access_token: tokens.access_token,
        p_refresh_token: tokens.refresh_token || null,
        p_expires_at: expiresAt,
      })
      if (storeError) {
        console.error(`[ms-auth/callback] Failed to store tokens: ${storeError.message}`)
        await supabase
          .from('user_ms_graph_links')
          .update({
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token || undefined,
            expires_at: expiresAt,
            status: 'active',
            code_verifier: null,
            processing_since: null,
            retry_after: null,
            updated_at: new Date().toISOString(),
          })
          .eq('user_id', userId)
      } else {
        await supabase
          .from('user_ms_graph_links')
          .update({ code_verifier: null })
          .eq('user_id', userId)
      }
      console.log(`[ms-auth/callback] OAuth successful for user ${userId} via ${oauthConfig.source} config (ms_tenant=${oauthConfig.tenantId})`)
      const frontendUrl = Deno.env.get('FRONTEND_URL') || supabaseUrl
      return Response.redirect(`${frontendUrl}?auth_success=true&has_refresh_token=${!!tokens.refresh_token}`)
    }

    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[ms-auth] Error: ${message}`)
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
