import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"
import { encodeBase64 } from "jsr:@std/encoding/base64"

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
    const { recipient, subject, content, attachments = [], correlation_id, scheduled_at } = body
    const finalCorrId = correlation_id || crypto.randomUUID()

    if (!recipient || !subject || !content) {
      return new Response(JSON.stringify({ error: 'Missing required fields: recipient, subject, content' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 1. Check token status
    const { data: tokenStatus, error: statusError } = await supabase.rpc('get_token_status', { p_user_id: userId })
    if (statusError) {
      return new Response(JSON.stringify({ error: 'Failed to check token status: ' + statusError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const statusRow = tokenStatus && tokenStatus.length > 0 ? tokenStatus[0] : null

    if (!statusRow || !statusRow.token_exists) {
      return new Response(JSON.stringify({ error: 'No Microsoft Graph token configured. Please add your access token in Settings.', code: 'token_expired' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (statusRow.status === 'token_expired') {
      return new Response(JSON.stringify({ error: 'Microsoft Graph token has expired. Please update your access token in Settings.', code: 'token_expired' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 2. Check rate limit (Retry-After)
    if (statusRow.retry_after && new Date(statusRow.retry_after) > new Date()) {
      const retryAfterSeconds = Math.ceil((new Date(statusRow.retry_after).getTime() - Date.now()) / 1000)
      return new Response(JSON.stringify({
        error: 'Rate limited by Microsoft Graph. Please try again later.',
        code: 'rate_limited',
        retry_after: statusRow.retry_after,
        retry_after_seconds: retryAfterSeconds
      }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) }
      })
    }

    // 3. Get tenant_id for hardbounce check and audit logging
    const { data: membership } = await supabase.from('memberships').select('tenant_id').eq('user_id', userId).single()
    const tenantId = membership?.tenant_id || null

    // 4. Handle scheduled sends
    const parsedScheduledAt = scheduled_at ? new Date(scheduled_at) : null
    if (scheduled_at && isNaN(parsedScheduledAt!.getTime())) {
      return new Response(JSON.stringify({ error: "Invalid scheduled_at date format" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    if (scheduled_at && parsedScheduledAt > new Date()) {
      let trackingId = finalCorrId
      let sendId: string | null = null
      if (tenantId) {
        const { data: sendRow, error: sendInsertError } = await supabase.from("email_sends").insert({
          tenant_id: tenantId,
          tracking_id: trackingId,
          recipient_email: recipient,
          subject,
          html_content: content,
          status: "scheduled",
          send_at: parsedScheduledAt!.toISOString(),
          user_id: userId,
        }).select("id").maybeSingle()
        if (!sendInsertError && sendRow) {
          sendId = sendRow.id
        }
      }
      return new Response(JSON.stringify({
        success: true,
        correlation_id: finalCorrId,
        scheduled: true,
        scheduled_at: parsedScheduledAt!.toLocaleString(),
        send_id: sendId,
        message: `Email scheduled for ${parsedScheduledAt!.toLocaleString()}. It will be sent automatically at that time.`
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" }
      })
    }

    // 5. Hardbounce check
    if (tenantId) {
      const { data: contact } = await supabase.from('contacts').select('status').eq('tenant_id', tenantId).eq('email', recipient).single()
      if (contact?.status === 'hardbounced') {
        return new Response(JSON.stringify({ error: 'Contact is hardbounced, cannot send', code: 'hardbounced' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    // 6. Get access token from vault
    const { data: accessToken, error: tokenError } = await supabase.rpc('get_ms_graph_access_token', { p_user_id: userId })
    if (tokenError || !accessToken) {
      await supabase.rpc('mark_token_expired', { p_user_id: userId })
      return new Response(JSON.stringify({ error: 'Token expired or unavailable. Please update your access token in Settings.', code: 'token_expired' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 7. Create email_sends record for tracking
    let trackingId = finalCorrId
    let sendId: string | null = null
    if (tenantId) {
      const { data: sendRow, error: sendInsertError } = await supabase.from('email_sends').insert({
        tenant_id: tenantId,
        tracking_id: trackingId,
        recipient_email: recipient,
        subject,
        html_content: content,
        status: 'processing',
        user_id: userId
      }).select('id').single()
      if (!sendInsertError && sendRow) {
        sendId = sendRow.id
      }
    }

    // 8. Build email payload with tracking
    const baseUrl = supabaseUrl
    const trackOpenUrl = baseUrl + '/functions/v1/track-open-v2?tid=' + trackingId
    const trackClickUrl = baseUrl + '/functions/v1/track-click-v2?tid=' + trackingId
    const trackingPixel = '<img src="' + trackOpenUrl + '" width="1" height="1" style="display:none" />'
    const wrappedContent = content.replace(/href="([^"]+)"/g, 'href="' + trackClickUrl + '&url=$1"') + trackingPixel
    let emailStatus: 'sent' | 'failed' = 'failed'
    let errorDetail: string | null = null
    let actualAttachmentSize = 0

    try {
      const downloadedFiles: { name: string; bytes: Uint8Array; size: number }[] = []
      for (const att of attachments) {
        const { data: fileData, error: downloadError } = await supabase.storage.from('dfsdfsdf').download(att.path)
        if (downloadError || !fileData) {
          throw new Error('Failed to download ' + att.name + ' from Supabase Storage: ' + (downloadError?.message || 'unknown'))
        }
        const arrayBuffer = await fileData.arrayBuffer()
        const bytes = new Uint8Array(arrayBuffer)
        actualAttachmentSize += bytes.byteLength
        downloadedFiles.push({ name: att.name, bytes, size: bytes.byteLength })
      }

      const MB_3 = 3 * 1024 * 1024

      if (attachments.length > 0 && actualAttachmentSize > MB_3) {
        const draftResp = await fetch('https://graph.microsoft.com/v1.0/me/messages', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subject,
            toRecipients: [{ emailAddress: { address: recipient } }],
            body: { contentType: 'HTML', content: wrappedContent }
          })
        })
        const draft = await draftResp.json()
        if (!draftResp.ok) {
          if (draftResp.status === 401) {
            await supabase.rpc('mark_token_expired', { p_user_id: userId })
            return new Response(JSON.stringify({ error: 'Token expired. Please update your access token in Settings.', code: 'token_expired' }), {
              status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            })
          }
          throw new Error('Failed to create draft: ' + JSON.stringify(draft))
        }

        const messageId = draft.id
        for (const file of downloadedFiles) {
          const sessionResp = await fetch('https://graph.microsoft.com/v1.0/me/messages/' + messageId + '/attachments/createUploadSession', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
            body: JSON.stringify({ AttachmentItem: { attachmentType: 'file', name: file.name, size: file.size } })
          })
          const session = await sessionResp.json()
          if (!sessionResp.ok) throw new Error('Failed to create upload session')
          const uploadUrl = session.uploadUrl
          const CHUNK_SIZE = 320 * 1024
          for (let start = 0; start < file.size; start += CHUNK_SIZE) {
            const end = Math.min(start + CHUNK_SIZE - 1, file.size - 1)
            const chunk = file.bytes.slice(start, end + 1)
            const upResp = await fetch(uploadUrl, {
              method: 'PUT',
              headers: { 'Content-Length': String(chunk.byteLength), 'Content-Range': 'bytes ' + start + '-' + end + '/' + file.size },
              body: chunk
            })
            if (!upResp.ok) throw new Error('Upload failed for ' + file.name + ' at bytes ' + start + '-' + end)
          }
        }

        const sendResp = await fetch('https://graph.microsoft.com/v1.0/me/messages/' + messageId + '/send', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + accessToken }
        })
        if (!sendResp.ok) throw new Error('Failed to send message after upload.')
        emailStatus = 'sent'
      } else {
        const graphAttachments = downloadedFiles.map(f => ({
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: f.name,
          contentType: 'application/octet-stream',
          contentBytes: encodeBase64(f.bytes)
        }))

        const payload: Record<string, unknown> = {
          message: {
            subject,
            body: { contentType: 'HTML', content: wrappedContent },
            toRecipients: [{ emailAddress: { address: recipient } }],
            ...(graphAttachments.length > 0 ? { attachments: graphAttachments } : {})
          },
          saveToSentItems: 'true'
        }

        const resp = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        })

        if (resp.status === 401) {
          await supabase.rpc('mark_token_expired', { p_user_id: userId })
          return new Response(JSON.stringify({ error: 'Token expired. Please update your access token in Settings.', code: 'token_expired' }), {
            status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          })
        }

        if (resp.status === 429) {
          const retryAfterHeader = resp.headers.get('Retry-After')
          const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader) : 3600
          const retryAfterDate = new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
          await supabase.rpc('set_retry_after', { p_user_id: userId, p_retry_after: retryAfterDate })
          return new Response(JSON.stringify({
            error: 'Rate limited by Microsoft Graph. Please try again later.',
            code: 'rate_limited',
            retry_after: retryAfterDate,
            retry_after_seconds: retryAfterSeconds
          }), {
            status: 429,
            headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) }
          })
        }

        if (!resp.ok) {
          const errText = await resp.text()
          throw new Error('Graph API Error: ' + errText)
        }

        emailStatus = 'sent'
      }
    } catch (e) {
      errorDetail = e instanceof Error ? e.message : 'Unknown error'
      emailStatus = 'failed'
    }

    // 9. Update email_sends record with final status
    if (sendId) {
      if (emailStatus === 'sent') {
        await supabase.from('email_sends').update({ status: 'sent', sent_at: new Date().toISOString() }).eq('id', sendId)
        if (attachments.length > 0) {
          const attRows = attachments.map((a: { name: string; path: string; size: number }) => ({
            send_id: sendId,
            file_name: a.name,
            file_path: a.path,
            file_size: a.size
          }))
          await supabase.from('send_attachments').insert(attRows)
        }
      } else {
        await supabase.from('email_sends').update({ status: 'failed', failure_reason: errorDetail }).eq('id', sendId)
      }
    }

    // 10. Increment send count on success
    if (emailStatus === 'sent') {
      await supabase.rpc('increment_send_count', { p_user_id: userId })
    }

    // 11. Log to email_audit
    if (tenantId) {
      await supabase.rpc('log_email_event', {
        p_tenant_id: tenantId,
        p_correlation_id: finalCorrId,
        p_sent_by: userId,
        p_recipient: recipient,
        p_subject: subject,
        p_status: emailStatus,
        p_error_detail: errorDetail,
        p_metadata: { attachments, hasAttachment: attachments.length > 0, attachmentSize: actualAttachmentSize }
      })
    }

    if (emailStatus === 'failed') {
      return new Response(JSON.stringify({ error: errorDetail, code: 'send_failed' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    return new Response(JSON.stringify({ success: true, correlation_id: finalCorrId }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return new Response(JSON.stringify({ error: message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})