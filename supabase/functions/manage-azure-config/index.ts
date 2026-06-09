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
 * Allows tenant admins to configure their own Azure AD app registration
 * credentials so the OAuth flow works for their specific domain.
 *
 * Endpoints:
 * - GET  → Returns current Azure AD config for the user's tenant (secrets masked)
 * - PUT  → Saves Azure AD config (client_id, client_secret, tenant_id) to tenants table
 *
 * Only admins can modify Azure AD config.
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

    // Get the user's membership and role
    const { data: membership, error: membershipError } = await supabase
      .from('memberships')
      .select('tenant_id, role')
      .eq('user_id', userId)
      .maybeSingle()

    if (membershipError || !membership) {
      return new Response(JSON.stringify({ error: 'No tenant membership found' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const tenantId = membership.tenant_id
    const isAdmin = membership.role === 'admin'

    // ==========================================
    // GET — Return current Azure AD config (secrets masked)
    // ==========================================
    if (req.method === 'GET') {
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

      // Check if env vars are set as a fallback
      const hasEnvFallback = !!(
        Deno.env.get('MS_CLIENT_ID') &&
        Deno.env.get('MS_CLIENT_SECRET') &&
        Deno.env.get('MS_TENANT_ID')
      )

      return new Response(JSON.stringify({
        // Tenant-specific config (mask the secret)
        ms_client_id: tenant?.ms_client_id || null,
        ms_client_secret_set: !!tenant?.ms_client_secret,
        ms_client_secret_masked: tenant?.ms_client_secret
          ? tenant.ms_client_secret.substring(0, 4) + '****' + tenant.ms_client_secret.substring(tenant.ms_client_secret.length - 4)
          : null,
        ms_tenant_id: tenant?.ms_tenant_id || null,
        has_config: hasConfig,
        // Env var fallback status
        has_env_fallback: hasEnvFallback,
        // Config source
        config_source: hasConfig ? 'tenant' : (hasEnvFallback ? 'environment' : 'none'),
        // Permissions
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
      const { ms_client_id, ms_client_secret, ms_tenant_id } = body

      // Validate required fields
      if (!ms_client_id || !ms_client_secret || !ms_tenant_id) {
        return new Response(JSON.stringify({
          error: 'All three fields are required: ms_client_id, ms_client_secret, ms_tenant_id'
        }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Basic format validation
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

      // Save to tenants table
      const { error: updateError } = await supabase
        .from('tenants')
        .update({
          ms_client_id: ms_client_id,
          ms_client_secret: ms_client_secret,
          ms_tenant_id: ms_tenant_id,
        })
        .eq('id', tenantId)

      if (updateError) {
        console.error(`[manage-azure-config] Failed to save: ${updateError.message}`)
        return new Response(JSON.stringify({ error: `Failed to save: ${updateError.message}` }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      console.log(`[manage-azure-config] Azure AD config updated for tenant ${tenantId} by user ${userId}`)

      return new Response(JSON.stringify({
        success: true,
        message: 'Azure AD configuration saved. Users can now connect their Microsoft accounts using your organization\'s app registration.',
        config_source: 'tenant',
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
