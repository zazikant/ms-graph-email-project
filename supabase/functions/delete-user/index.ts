import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { email, tenant_id, requesting_user_id } = await req.json()

    if (!email || !tenant_id) {
      return new Response(JSON.stringify({ error: 'Missing email or tenant_id' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Verify the requesting user is an admin
    const { data: requestingMembership } = await supabase
      .from('memberships')
      .select('role')
      .eq('user_id', requesting_user_id)
      .eq('tenant_id', tenant_id)
      .single()

    if (!requestingMembership || requestingMembership.role !== 'admin') {
      return new Response(JSON.stringify({ error: 'Not authorized' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Find the user by email
    const { data: userData, error: userError } = await supabase
      .from('users')
      .select('id')
      .eq('email', email)
      .single()

    if (userError || !userData) {
      // Try auth.users directly via admin API
      // First delete from memberships
      await supabase
        .from('memberships')
        .delete()
        .eq('tenant_id', tenant_id)
        .eq('user_id', (await supabase.auth.admin.listUsers()).users.find(u => u.email === email)?.id || '')

      return new Response(JSON.stringify({ success: true, message: 'Membership deleted' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Delete from memberships first
    const { error: memberError } = await supabase
      .from('memberships')
      .delete()
      .eq('user_id', userData.id)
      .eq('tenant_id', tenant_id)

    if (memberError) {
      return new Response(JSON.stringify({ error: 'Failed to delete membership: ' + memberError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Delete from auth.users using admin API
    const adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    })

    // Use the REST API to delete the user
    const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userData.id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${supabaseServiceKey}`,
        'apikey': supabaseServiceKey,
      }
    })

    if (!response.ok && response.status !== 404) {
      console.error('Failed to delete auth user:', await response.text())
      // Don't fail the whole operation if auth delete fails - membership is already deleted
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})