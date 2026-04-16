import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const SEND_DELAY_MS = 150
const MAX_RETRIES = 3

const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
const supabase = createClient(supabaseUrl, supabaseServiceKey)

async function refreshAccessToken(clientId: string, clientSecret: string, refreshToken: string) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/.default'
  })

  const response = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })

  if (!response.ok) {
    const err = await response.text()
    throw new Error('Token refresh failed: ' + err)
  }

  const data = await response.json()
  return data.access_token
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const now = new Date()
    const nowIso = now.toISOString()
    
    const { data: scheduledEmails, error: fetchError } = await supabase
      .from('email_sends')
      .select('*')
      .eq('status', 'scheduled')
      .or('send_at.is.null,send_at.lte.' + nowIso)
      .order('created_at', { ascending: true })
      .limit(20)

    if (fetchError) throw fetchError

    let sentCount = 0
    let failedCount = 0
    let skippedCount = 0
    let tokenRefreshFailed = false
    let rateLimited = false

    for (let i = 0; i < (scheduledEmails || []).length; i++) {
      const email = scheduledEmails[i]
      
      const { data: contact } = await supabase
        .from('contacts')
        .select('status')
        .eq('tenant_id', email.tenant_id)
        .eq('email', email.recipient_email)
        .single()
      
      if (contact?.status === 'hardbounced') {
        console.log(`Skipping ${email.recipient_email} - contact is hardbounced`)
        await supabase.from('email_sends').update({ status: 'failed', failure_reason: 'Hardbounced contact' }).eq('id', email.id)
        skippedCount++
        continue
      }
      
      if (tokenRefreshFailed || rateLimited) {
        skippedCount++
        continue
      }

      try {
        await sendViaGraphWithRetry(supabase, email.tenant_id, email.user_id, email.id, email.tracking_id, 
          email.recipient_email, email.subject, email.html_content, null)
        sentCount++
      } catch (err) {
        const errMsg = err.message || ''
        if (errMsg.includes('no refresh token') || errMsg.includes('Token refresh failed') || errMsg.includes('Token revoked') || errMsg.includes('will retry when token')) {
          console.log('Token issue, stopping. Remaining emails will retry when token is updated.')
          tokenRefreshFailed = true
          skippedCount = (scheduledEmails?.length || 0) - sentCount - failedCount
        } else if (errMsg.includes('rate limit') || errMsg.includes('429')) {
          console.log('Rate limited, pausing. Remaining emails will retry later.')
          rateLimited = true
          skippedCount = (scheduledEmails?.length || 0) - sentCount - failedCount - (scheduledEmails?.length || 0) + i + 1
        } else {
          failedCount++
        }
      }

      if (i < (scheduledEmails?.length || 0) - 1) {
        await new Promise(r => setTimeout(r, SEND_DELAY_MS))
      }
    }

    return new Response(JSON.stringify({ 
      processed: (scheduledEmails?.length || 0) - skippedCount, 
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
      reason: tokenRefreshFailed ? 'Token issue - update in Settings to retry' : 
              rateLimited ? 'Rate limited, will retry on next cron run' : null
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

async function sendViaGraphWithRetry(supabase: any, tenant_id: string, user_id: string, send_id: string, tracking_id: string, recipient: string, subject: string, html: string, attachments: any, retries = MAX_RETRIES) {
  await supabase.from('email_sends').update({ status: 'processing' }).eq('id', send_id)

  const { data: membership } = await supabase
    .from('memberships')
    .select('ms_access_token, ms_refresh_token, tenant_id, user_id')
    .eq('tenant_id', tenant_id)
    .eq('user_id', user_id)
    .single()

  if (!membership?.ms_access_token) {
    await supabase.from('email_sends').update({ status: 'scheduled' }).eq('id', send_id)
    throw new Error('No Microsoft access token configured - will retry when token is updated')
  }

  let accessToken = membership.ms_access_token
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      accessToken = await doSendEmail(supabase, accessToken, send_id, tracking_id, recipient, subject, html, attachments)
      return
    } catch (err) {
      const errMsg = err.message || ''
      if (errMsg.includes('401') || errMsg.includes('AuthenticationError')) {
        console.log('Access token expired, trying refresh...')
        
        const { data: tenant } = await supabase.from('tenants').select('ms_client_id, ms_client_secret').eq('id', tenant_id).single()
        
        if (tenant?.ms_client_id && tenant?.ms_client_secret && membership.ms_refresh_token) {
          try {
            accessToken = await refreshAccessToken(tenant.ms_client_id, tenant.ms_client_secret, membership.ms_refresh_token)
            await supabase.from('memberships').update({ ms_access_token: accessToken }).eq('tenant_id', tenant_id).eq('user_id', user_id)
            accessToken = await doSendEmail(supabase, accessToken, send_id, tracking_id, recipient, subject, html, attachments)
            return
          } catch (refreshErr) {
            const refreshErrMsg = refreshErr.message || ''
            if (refreshErrMsg.includes('invalid_grant') || refreshErrMsg.includes('refresh_token')) {
              await supabase.from('email_sends').update({ status: 'scheduled' }).eq('id', send_id)
              throw new Error('Token revoked or expired - will retry when token is updated in Settings')
            }
            if (attempt < retries - 1) {
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
              continue
            }
          }
        } else {
          await supabase.from('email_sends').update({ status: 'scheduled' }).eq('id', send_id)
          throw new Error('No refresh token - will retry when token is updated in Settings')
        }
      } else if (errMsg.includes('429') || errMsg.includes('rate limit')) {
        await supabase.from('email_sends').update({ status: 'scheduled' }).eq('id', send_id)
        throw new Error('rate limit - will retry later')
      } else {
        if (attempt < retries - 1) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          continue
        }
        await supabase.from('email_sends').update({ status: 'failed', failure_reason: err.message }).eq('id', send_id)
        throw err
      }
    }
  }
  
  await supabase.from('email_sends').update({ status: 'scheduled' }).eq('id', send_id)
  throw new Error('Max retries exceeded - will retry later')
}

async function doSendEmail(supabase: any, accessToken: string, send_id: string, tracking_id: string, recipient: string, subject: string, html: string, attachments: any) {
  const baseUrl = Deno.env.get('SUPABASE_URL')!
  const trackOpenUrl = baseUrl + '/functions/v1/track-open-v2?tid=' + tracking_id
  const trackClickUrl = baseUrl + '/functions/v1/track-click-v2?tid=' + tracking_id

  const trackingPixel = '<img src="' + trackOpenUrl + '" width="1" height="1" style="display:none" />'
  const wrappedHtml = html.replace(/href="([^"]+)"/g, 'href="' + trackClickUrl + '&url=$1"') + trackingPixel

  let graphAttachments: any[] = []
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      const { data: fileData } = await supabase.storage.from('dfsdfsdf').download(att.path)
      if (fileData) {
        const bytes = new Uint8Array(await fileData.arrayBuffer())
        const base64 = btoa(String.fromCharCode(...bytes))
        graphAttachments.push({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: att.name,
          contentBytes: base64
        })
      }
    }
  }

  const payload: any = {
    message: {
      subject,
      body: { contentType: 'HTML', content: wrappedHtml },
      toRecipients: [{ emailAddress: { address: recipient } }]
    },
    saveToSentItems: "true"
  }

  if (graphAttachments.length > 0) {
    payload.message.attachments = graphAttachments
  }

  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })

  if (!response.ok) {
    const error = await response.text()
    if (response.status === 429) {
      throw new Error('429: rate limit exceeded')
    }
    throw new Error('401:' + error)
  }

  await supabase.from('email_sends').update({ 
    status: 'sent', 
    sent_at: new Date().toISOString() 
  }).eq('id', send_id)
  
  return accessToken
}