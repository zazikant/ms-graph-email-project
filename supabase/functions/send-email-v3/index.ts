import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const MS_TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

async function refreshAccessToken(clientId, clientSecret, refreshToken) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: 'https://graph.microsoft.com/.default'
  });

  const response = await fetch(MS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error('Token refresh failed: ' + err);
  }

  const data = await response.json();
  return data.access_token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    const body = await req.json();
    const { recipient_email, subject, html_content, attachments, send_now = true, send_at, tenant_id } = body;

    if (!recipient_email || !subject || !html_content) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (!tenant_id) {
      return new Response(JSON.stringify({ error: 'No tenant configured' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // HARDBOUNCE CHECK - reject if contact is hardbounced
    const { data: contact } = await supabase
      .from('contacts')
      .select('status')
      .eq('tenant_id', tenant_id)
      .eq('email', recipient_email)
      .single();

    if (contact?.status === 'hardbounced') {
      return new Response(JSON.stringify({ error: 'Contact is hardbounced, cannot send' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const tracking_id = crypto.randomUUID();

    const { data: sendRecord, error: sendError } = await supabase
      .from('email_sends')
      .insert({
        tenant_id,
        tracking_id,
        recipient_email,
        subject,
        html_content,
        status: send_now ? 'processing' : 'scheduled',
        send_at: send_at || null
      })
      .select()
      .single();

    if (sendError) throw sendError;

    if (attachments && attachments.length > 0) {
      for (const att of attachments) {
        await supabase.from('send_attachments').insert({
          send_id: sendRecord.id,
          file_name: att.name,
          storage_path: att.path
        });
      }
    }

    if (send_now) {
      await sendViaGraph(supabase, tenant_id, sendRecord.id, tracking_id, recipient_email, subject, html_content, attachments);
    }

    return new Response(JSON.stringify({ success: true, tracking_id, send_id: sendRecord.id }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

async function sendViaGraph(supabase, tenant_id, send_id, tracking_id, recipient, subject, html, attachments) {
  const { data: membership } = await supabase
    .from('memberships')
    .select('ms_access_token, ms_refresh_token, tenant_id, user_id')
    .eq('tenant_id', tenant_id)
    .single();

  if (!membership?.ms_access_token) {
    await supabase.from('email_sends').update({ status: 'failed' }).eq('id', send_id);
    throw new Error('No Microsoft access token configured');
  }

  let accessToken = membership.ms_access_token;
  
  try {
    accessToken = await doSendEmail(supabase, accessToken, send_id, tracking_id, recipient, subject, html, attachments);
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('AuthenticationError')) {
      console.log('Access token expired, trying refresh...');
      
      const { data: tenant } = await supabase.from('tenants').select('ms_client_id, ms_client_secret').eq('id', tenant_id).single();
      
      if (tenant?.ms_client_id && tenant?.ms_client_secret && membership.ms_refresh_token) {
        try {
          accessToken = await refreshAccessToken(tenant.ms_client_id, tenant.ms_client_secret, membership.ms_refresh_token);
          await supabase.from('memberships').update({ ms_access_token: accessToken }).eq('tenant_id', tenant_id);
          accessToken = await doSendEmail(supabase, accessToken, send_id, tracking_id, recipient, subject, html, attachments);
        } catch (refreshErr) {
          await supabase.from('email_sends').update({ status: 'failed' }).eq('id', send_id);
          throw new Error('Token refresh failed: ' + refreshErr.message);
        }
      } else {
        await supabase.from('email_sends').update({ status: 'failed' }).eq('id', send_id);
        throw new Error('Access token expired, no refresh token configured');
      }
    } else {
      throw err;
    }
  }
}

async function doSendEmail(supabase, accessToken, send_id, tracking_id, recipient, subject, html, attachments) {
  const baseUrl = Deno.env.get('SUPABASE_URL')!;
  const trackOpenUrl = baseUrl + '/functions/v1/track-open-v2?tid=' + tracking_id;
  const trackClickUrl = baseUrl + '/functions/v1/track-click-v2?tid=' + tracking_id;

  const trackingPixel = '<img src="' + trackOpenUrl + '" width="1" height="1" style="display:none" />';
  const wrappedHtml = html.replace(/href="([^"]+)"/g, 'href="' + trackClickUrl + '&url=$1"') + trackingPixel;

  let graphAttachments = [];
  if (attachments && attachments.length > 0) {
    for (const att of attachments) {
      const { data: fileData } = await supabase.storage.from('dfsdfsdf').download(att.path);
      if (fileData) {
        const bytes = new Uint8Array(await fileData.arrayBuffer());
        const base64 = btoa(String.fromCharCode(...bytes));
        graphAttachments.push({
          "@odata.type": "#microsoft.graph.fileAttachment",
          name: att.name,
          contentBytes: base64
        });
      }
    }
  }

  const payload = {
    message: {
      subject,
      body: { contentType: 'HTML', content: wrappedHtml },
      toRecipients: [{ emailAddress: { address: recipient } }]
    },
    saveToSentItems: "true"
  };

  if (graphAttachments.length > 0) {
    payload.message.attachments = graphAttachments;
  }

  const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + accessToken,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error('401:' + error);
  }

  await supabase.from('email_sends').update({ 
    status: 'sent', 
    sent_at: new Date().toISOString() 
  }).eq('id', send_id);
  
  return accessToken;
}