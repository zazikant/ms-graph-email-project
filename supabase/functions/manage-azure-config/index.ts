import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
}

/**
 * Azure AD App Configuration Edge Function
 *
 * Allows tenant admins to configure Azure AD app registration credentials
 * for either the entire Supabase tenant OR for a specific member whose
 * Microsoft Entra ID directory differs from the tenant default.
 *
 * Endpoints:
 * - GET  ?target_user_id=<uuid>  → Returns effective config for that user (secrets masked)
 * - PUT  ?target_user_id=<uuid>  → Saves Azure AD config to either tenants (default) or user_ms_graph_links (when target_user_id is set)
 *
 * Only admins can modify Azure AD config.
 *
 * The lookup order is documented in _shared/getOAuthConfig.ts:
 *   1. per-user row in user_ms_graph_links
 *   2. per-tenant row in tenants
 *   3. env vars
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

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

    const { data: membership } = await supabase
      .from('memberships')
      .select('tenant_id, role')
      .eq('user_id', userId)
      .maybeSingle()

    if (!membership) {
      return new Response(JSON.stringify({ error: 'No tenant membership found' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const tenantId = membership.tenant_id
    const isAdmin = membership.role === 'admin'

    // target_user_id selects per-user mode; omit for tenant-wide (back-compat)
    const url = new URL(req.url)
    const targetUserId = url.searchParams.get('target_user_id') || null

    // ==========================================
    // GET — Return current Azure AD config (secrets masked)
    // ==========================================
    if (req.method === 'GET') {
      if (targetUserId) {
        // Per-user lookup via the view
        const { data: row } = await supabase.rpc('get_effective_azure_config', { p_user_id: targetUserId })
        const r = row && row[0]
        const { data: userLink } = await supabase
          .from('user_ms_graph_links')
          .select('ms_client_secret')
          .eq('user_id', targetUserId)
          .maybeSingle()
        const { data: tenantRow } = await supabase
          .from('tenants')
          .select('ms_client_secret')
          .eq('id', tenantId)
          .maybeSingle()
        const secret = (r?.source === 'user' ? userLink?.ms_client_secret : tenantRow?.ms_client_secret) || null

        return new Response(JSON.stringify({
          target_user_id: targetUserId,
          ms_client_id: r?.client_id || null,
          ms_client_secret_set: !!secret,
          ms_client_secret_masked: secret
            ? secret.substring(0, 4) + '****' + secret.substring(secret.length - 4)
            : null,
          ms_tenant_id: r?.microsoft_tenant_id || null,
          ms_authority_host: r?.authority_host || 'https://login.microsoftonline.com',
          has_config: !!r?.client_id,
          config_source: r?.source || 'none',
          is_admin: isAdmin,
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Tenant-wide lookup (back-compat path)
      const { data: tenant, error: tenantError } = await supabase
        .from('tenants')
        .select('ms_client_id, ms_client_secret, ms_tenant_id')
        .eq('id', tenantId)
        .maybeSingle()

      if (tenantError) {
        return new Response(JSON.stringify({ error: tenantError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const hasConfig = !!(tenant?.ms_client_id && tenant?.ms_client_secret && tenant?.ms_tenant_id)
      const hasEnvFallback = !!(
        Deno.env.get('MS_CLIENT_ID') &&
        Deno.env.get('MS_CLIENT_SECRET') &&
        Deno.env.get('MS_TENANT_ID')
      )

      return new Response(JSON.stringify({
        ms_client_id: tenant?.ms_client_id || null,
        ms_client_secret_set: !!tenant?.ms_client_secret,
        ms_client_secret_masked: tenant?.ms_client_secret
          ? tenant.ms_client_secret.substring(0, 4) + '****' + tenant.ms_client_secret.substring(tenant.ms_client_secret.length - 4)
          : null,
        ms_tenant_id: tenant?.ms_tenant_id || null,
        has_config: hasConfig,
        has_env_fallback: hasEnvFallback,
        config_source: hasConfig ? 'tenant' : (hasEnvFallback ? 'environment' : 'none'),
        is_admin: isAdmin,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // ==========================================
    // PUT — Save Azure AD config (admin only)
    // ==========================================
    if (req.method === 'PUT') {
      if (!isAdmin) {
        return new Response(JSON.stringify({
          error: 'Only admins can configure Azure AD settings for this organization.'
        }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const body = await req.json()
      const { ms_client_id, ms_client_secret, ms_tenant_id, ms_authority_host } = body

      if (!ms_client_id || !ms_client_secret || !ms_tenant_id) {
        return new Response(JSON.stringify({
          error: 'All three fields are required: ms_client_id, ms_client_secret, ms_tenant_id'
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      if (!ms_client_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        return new Response(JSON.stringify({ error: 'Client ID must be a valid GUID format' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      if (!ms_tenant_id.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
        return new Response(JSON.stringify({ error: 'Tenant ID must be a valid GUID format' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Per-user save
      if (targetUserId) {
        const { data, error } = await supabase.rpc('set_user_azure_config', {
          p_requesting_user_id: userId,
          p_target_user_id: targetUserId,
          p_client_id: ms_client_id,
          p_client_secret: ms_client_secret,
          p_microsoft_tenant_id: ms_tenant_id,
          p_authority_host: ms_authority_host || 'https://login.microsoftonline.com',
        })
        if (error) {
          console.error(`[manage-azure-config] Failed to save per-user config: ${error.message}`)
          return new Response(JSON.stringify({ error: `Failed to save: ${error.message}` }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
        console.log(`[manage-azure-config] Per-user Azure config set for user ${targetUserId} by admin ${userId}`)
        return new Response(JSON.stringify({
          success: true,
          target_user_id: targetUserId,
          config_source: 'user',
          message: 'Per-user Azure AD configuration saved. This user will now use their own Azure app registration.',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Tenant-wide save (back-compat)
      const { error: updateError } = await supabase
        .from('tenants')
        .update({
          ms_client_id: ms_client_id,
          ms_client_secret: ms_client_secret,
          ms_tenant_id: ms_tenant_id,
        })
        .eq('id', tenantId)

      if (updateError) {
        console.error(`[manage-azure-config] Failed to save tenant config: ${updateError.message}`)
        return new Response(JSON.stringify({ error: `Failed to save: ${updateError.message}` }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log(`[manage-azure-config] Tenant Azure AD config updated for tenant ${tenantId} by user ${userId}`)

      return new Response(JSON.stringify({
        success: true,
        config_source: 'tenant',
        message: 'Azure AD configuration saved. Users in your organization will use this app registration (unless they have a per-user override).',
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error(`[manage-azure-config] Error: ${message}`)
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
