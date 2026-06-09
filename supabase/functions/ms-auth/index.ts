import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

/**
 * Microsoft Graph OAuth2 Edge Function
 *
 * Handles the Authorization Code Flow with PKCE for Microsoft Graph API.
 * This replaces the manual "paste access token from Graph Explorer" workflow
 * with a proper OAuth flow that provides both access_token AND refresh_token.
 *
 * Endpoints:
 * - GET /authorize  → Redirects user to Microsoft login
 * - GET /callback   → Handles the OAuth callback, exchanges code for tokens
 *
 * Required env vars (from tenants table or environment):
 * - MS_CLIENT_ID     → Azure AD App Registration client ID
 * - MS_CLIENT_SECRET → Azure AD App Registration client secret
 * - MS_TENANT_ID     → Azure AD tenant ID
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

const GRAPH_SCOPES = 'https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/Mail.ReadBasic https://graph.microsoft.com/User.Read https://graph.microsoft.com/User.ReadBasic.All offline_access'

/**
 * Generate PKCE code_verifier and code_challenge
 */
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

/**
 * Get OAuth credentials from the user's tenant or environment variables
 */
async function getOAuthConfig(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<{ clientId: string; clientSecret: string; tenantId: string } | null> {
  // First, try tenant-specific credentials
  const { data: membership } = await supabase
    .from('memberships')
    .select('tenant_id')
    .eq('user_id', userId)
    .maybeSingle()

  if (membership?.tenant_id) {
    const { data: tenant } = await supabase
      .from('tenants')
      .select('ms_client_id, ms_client_secret, ms_tenant_id')
      .eq('id', membership.tenant_id)
      .maybeSingle()

    if (tenant?.ms_client_id && tenant?.ms_client_secret && tenant?.ms_tenant_id) {
      return {
        clientId: tenant.ms_client_id,
        clientSecret: tenant.ms_client_secret,
        tenantId: tenant.ms_tenant_id,
      }
    }
  }

  // Fallback: environment variables
  const envClientId = Deno.env.get('MS_CLIENT_ID')
  const envClientSecret = Deno.env.get('MS_CLIENT_SECRET')
  const envTenantId = Deno.env.get('MS_TENANT_ID')

  if (envClientId && envClientSecret && envTenantId) {
    return { clientId: envClientId, clientSecret: envClientSecret, tenantId: envTenantId }
  }

  return null
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

    // ==========================================
    // GET /ms-auth/authorize — Start OAuth flow
    // ==========================================
    if (path.endsWith('/authorize') || path === '/ms-auth') {
      // Authenticate the user via Supabase session
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

      // Get OAuth config
      const oauthConfig = await getOAuthConfig(supabase, userId)
      if (!oauthConfig) {
        return new Response(JSON.stringify({
          error: 'Microsoft OAuth not configured. Please set MS_CLIENT_ID, MS_CLIENT_SECRET, MS_TENANT_ID in your tenant settings or environment variables.',
          code: 'oauth_not_configured'
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Generate PKCE
      const { verifier, challenge } = await generatePKCE()

      // Store code_verifier in user_ms_graph_links for later use in callback
      await supabase
        .from('user_ms_graph_links')
        .upsert({
          user_id: userId,
          code_verifier: verifier,
          status: 'active',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' })

      // Build authorization URL
      // Note: Do NOT append user_id as a query param here — Azure AD requires
      // the redirect_uri to exactly match the registered URI. The user ID is
      // already carried in the `state` parameter, which is the standard OAuth way.
      const callbackUrl = `${supabaseUrl}/functions/v1/ms-auth/callback`
      const authUrl = new URL(`https://login.microsoftonline.com/${oauthConfig.tenantId}/oauth2/v2.0/authorize`)
      authUrl.searchParams.set('client_id', oauthConfig.clientId)
      authUrl.searchParams.set('response_type', 'code')
      authUrl.searchParams.set('redirect_uri', callbackUrl)
      authUrl.searchParams.set('scope', GRAPH_SCOPES)
      authUrl.searchParams.set('code_challenge', challenge)
      authUrl.searchParams.set('code_challenge_method', 'S256')
      authUrl.searchParams.set('response_mode', 'query')
      authUrl.searchParams.set('state', userId)

      // Return the authorization URL for the frontend to redirect to
      return new Response(JSON.stringify({
        authorization_url: authUrl.toString(),
        message: 'Redirect the user to this URL to start the OAuth flow'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // ==========================================
    // GET /ms-auth/callback — Handle OAuth callback
    // ==========================================
    if (path.endsWith('/callback')) {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const errorDescription = url.searchParams.get('error_description')

      if (error) {
        console.error(`[ms-auth/callback] OAuth error: ${error} — ${errorDescription}`)
        // Redirect to frontend with error
        const frontendUrl = Deno.env.get('FRONTEND_URL') || supabaseUrl
        return Response.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(errorDescription || error)}`)
      }

      if (!code || !state) {
        return new Response(JSON.stringify({ error: 'Missing code or state parameter' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        })
      }

      const userId = state

      // Retrieve stored code_verifier
      const { data: linkData } = await supabase
        .from('user_ms_graph_links')
        .select('code_verifier')
        .eq('user_id', userId)
        .maybeSingle()

      if (!linkData?.code_verifier) {
        return new Response(JSON.stringify({ error: 'No PKCE verifier found — please restart the OAuth flow' }), {
          status: 400, headers: { 'Content-Type': 'application/json' }
        })
      }

      // Get OAuth config
      const oauthConfig = await getOAuthConfig(supabase, userId)
      if (!oauthConfig) {
        return new Response(JSON.stringify({ error: 'OAuth not configured' }), {
          status: 500, headers: { 'Content-Type': 'application/json' }
        })
      }

      // Exchange authorization code for tokens
      // Must use the same redirect_uri as in the authorize step (without query params)
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
        `https://login.microsoftonline.com/${oauthConfig.tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: tokenBody.toString(),
        }
      )

      const tokens = await tokenResp.json()

      if (!tokenResp.ok) {
        console.error(`[ms-auth/callback] Token exchange failed: ${tokens.error} — ${tokens.error_description}`)
        const frontendUrl = Deno.env.get('FRONTEND_URL') || supabaseUrl
        return Response.redirect(`${frontendUrl}?auth_error=${encodeURIComponent(tokens.error_description || tokens.error)}`)
      }

      // Calculate expiry time (subtract 5 min safety margin)
      const expiresInSec = tokens.expires_in || 3600
      const expiresAt = new Date(Date.now() + (expiresInSec - 300) * 1000).toISOString()

      // Store both access_token AND refresh_token
      const { error: storeError } = await supabase.rpc('store_ms_graph_access_token', {
        p_user_id: userId,
        p_access_token: tokens.access_token,
        p_refresh_token: tokens.refresh_token || null,
        p_expires_at: expiresAt,
      })

      if (storeError) {
        console.error(`[ms-auth/callback] Failed to store tokens: ${storeError.message}`)
        // Try direct update as fallback
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
        // Clear the code_verifier
        await supabase
          .from('user_ms_graph_links')
          .update({ code_verifier: null })
          .eq('user_id', userId)
      }

      console.log(`[ms-auth/callback] OAuth successful for user ${userId}, token expires at ${expiresAt}`)

      // Redirect back to the frontend settings page
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
