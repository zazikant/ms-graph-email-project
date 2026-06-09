import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
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
    const body = await req.json()
    const { list_id, subject, content, attachments, scheduled_at } = body

    if (!list_id || !subject || !content) {
      return new Response(JSON.stringify({ error: 'Missing required fields: list_id, subject, content' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', userId).single()
    if (!membership) {
      return new Response(JSON.stringify({ error: 'No tenant found for user' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }
    const tenantId = membership.tenant_id

    const { data: linkData, error: linkError } = await supabase
      .from('user_ms_graph_links')
      .select('status, expires_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (linkError || !linkData) {
      return new Response(JSON.stringify({ error: 'No Microsoft Graph token configured. Please add your access token in Settings.', code: 'token_expired' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (linkData.status === 'token_expired') {
      return new Response(JSON.stringify({ error: 'Microsoft Graph token has expired. Please update your access token in Settings.', code: 'token_expired' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const parsedScheduledAt = scheduled_at ? new Date(scheduled_at) : null
    if (scheduled_at && isNaN(parsedScheduledAt!.getTime())) {
      return new Response(JSON.stringify({ error: 'Invalid scheduled_at date format' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: batchIdResult, error: batchError } = await supabase.rpc('schedule_batch', {
      p_user_id: userId,
      p_tenant_id: tenantId,
      p_list_id: list_id,
      p_subject: subject,
      p_content: content,
      p_attachments: attachments || [],
      p_scheduled_at: scheduled_at ? parsedScheduledAt!.toISOString() : null
    })

    if (batchError || !batchIdResult) {
      return new Response(JSON.stringify({ error: batchError?.message || 'Failed to schedule batch' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { data: batch } = await supabase.from('batches').select('id, total_count, status, scheduled_at').eq('id', batchIdResult).single()

    const isScheduled = batch?.status === 'scheduled'
    const displayScheduledAt = batch?.scheduled_at
      ? new Date(batch.scheduled_at).toLocaleString()
      : null

    return new Response(JSON.stringify({
      success: true,
      batch_id: batchIdResult,
      total_count: batch?.total_count || 0,
      status: batch?.status ?? 'pending',
      scheduled_at: isScheduled ? displayScheduledAt : null,
      message: isScheduled
        ? `Batch scheduled for ${displayScheduledAt}. Processing will begin automatically at that time.`
        : `Batch queued! Processing will begin shortly.`
    }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
