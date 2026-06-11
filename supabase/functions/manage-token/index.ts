import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
}

/**
 * Decode JWT exp claim without external libraries.
 */
function getTokenExpiry(token: string): number | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    const decoded = JSON.parse(payload)
    if (decoded.exp) return decoded.exp * 1000
    return null
  } catch {
    return null
  }
}

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

    if (req.method === 'PUT') {
      const body = await req.json()
      const { access_token, refresh_token } = body

      if (!access_token || typeof access_token !== 'string') {
        return new Response(JSON.stringify({ error: 'access_token is required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      // Auto-detect token expiry from JWT claims
      let expiresAt: string | null = null
      const tokenExpiry = getTokenExpiry(access_token)
      if (tokenExpiry) {
        // Subtract 5 minutes as safety margin
        expiresAt = new Date(tokenExpiry - 5 * 60 * 1000).toISOString()
      }

      const { error } = await supabase.rpc('store_ms_graph_access_token', {
        p_user_id: userId,
        p_access_token: access_token,
        p_refresh_token: refresh_token || null,
        p_expires_at: expiresAt,
      })

      if (error) {
        // Fallback: try direct upsert if RPC fails
        const { error: upsertError } = await supabase
          .from('user_ms_graph_links')
          .upsert({
            user_id: userId,
            access_token: access_token,
            refresh_token: refresh_token || undefined,
            expires_at: expiresAt,
            status: 'active',
            processing_since: null,
            retry_after: null,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id' })

        if (upsertError) {
          return new Response(JSON.stringify({ error: upsertError.message }), {
            status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }
      }

      return new Response(JSON.stringify({
        success: true,
        status: 'active',
        expires_at: expiresAt,
        has_refresh_token: !!refresh_token,
        message: refresh_token
          ? 'Token saved with refresh token — automatic refresh enabled'
          : 'Token saved (no refresh token — token will expire in ~60-90 min)'
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase.rpc('delete_ms_graph_token', {
        p_user_id: userId
      })

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (req.method === 'GET') {
      const { data, error } = await supabase.rpc('get_token_status', {
        p_user_id: userId
      })

      if (error) {
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }

      const row = data && data.length > 0 ? data[0] : { token_exists: false, status: 'token_expired', retry_after: null, send_count: 0, expires_at: null, has_refresh_token: false }

      return new Response(JSON.stringify({
        has_token: row.token_exists,
        status: row.status,
        retry_after: row.retry_after,
        send_count: row.send_count,
        expires_at: row.expires_at,
        has_refresh_token: row.has_refresh_token || false
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
