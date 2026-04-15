import "jsr:@supabase/functions-js/edge-runtime.d.ts"

Deno.serve(async (req) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const fetchWithAuth = async (path: string, options: RequestInit = {}) => {
      return await fetch(`${supabaseUrl}${path}`, {
        ...options,
        headers: {
          ...options.headers,
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        },
      })
    }

    // Get all tenants
    const tenantsRes = await fetchWithAuth('/rest/v1/tenants?select=id')
    const tenants = await tenantsRes.json()

    let totalUpdated = 0

    for (const tenant of tenants) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      
      const failedSendsRes = await fetchWithAuth(
        `/rest/v1/email_sends?status=failed&tenant_id=eq.${tenant.id}&created_at=gt.${oneDayAgo}&select=recipient_email,tenant_id,failure_reason`
      )
      const failedSends = await failedSendsRes.json()

      if (!failedSends || failedSends.length === 0) continue

      const tokenRelatedKeywords = ['token', '401', 'AuthenticationError', 'refresh', 'expired', 'revoked']
      const genuineFailedEmails = failedSends.filter((s: any) => {
        const reason = (s.failure_reason || '').toLowerCase()
        const isTokenRelated = tokenRelatedKeywords.some(k => reason.includes(k.toLowerCase()))
        return !isTokenRelated
      })

      if (genuineFailedEmails.length === 0) continue

      const uniqueEmails = [...new Set(genuineFailedEmails.map((s: any) => s.recipient_email.toLowerCase()))]

      // Update contacts to hardbounced for these emails
      for (const email of uniqueEmails) {
        const updateRes = await fetchWithAuth(
          `/rest/v1/contacts?tenant_id=eq.${tenant.id}&email=eq.${encodeURIComponent(email)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
            body: JSON.stringify({ status: 'hardbounced' }),
          }
        )

        if (updateRes.ok) {
          totalUpdated++
        }
      }
    }

    return new Response(JSON.stringify({
      success: true,
      message: `Updated ${totalUpdated} contacts to hardbounced`,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({
      error: error.message || 'Unknown error'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})