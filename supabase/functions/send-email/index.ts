import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"
import { encodeBase64 } from "jsr:@std/encoding/base64"

const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const supabase = createClient(supabaseUrl, supabaseServiceKey);

async function getOrRefreshToken(userId: string) {
  const { data, error } = await supabase
    .from('user_ms_graph_links')
    .select('vault_secret_id')
    .eq('user_id', userId)
    .single()

  if (error || !data) throw new Error('No MS Graph token link found for user');
  
  const { data: currentRefreshToken, error: secretError } = await supabase.rpc('get_ms_graph_refresh_token', {
    p_user_id: userId
  });

  if (secretError || !currentRefreshToken) throw new Error('Could not retrieve token from vault');

  const tenantId = 'common';
  const clientId = Deno.env.get('MS_CLIENT_ID') || '';
  
  const response = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: currentRefreshToken,
      scope: 'https://graph.microsoft.com/.default offline_access'
    })
  });

  const tokens = await response.json();

  if (!response.ok) {
    if (tokens.error === 'invalid_grant') {
      throw new Error('RE_AUTH_REQUIRED');
    }
    throw new Error(`MS_AUTH_ERROR: ${tokens.error_description}`);
  }

  if (tokens.refresh_token && tokens.refresh_token !== currentRefreshToken) {
    await supabase.rpc('store_ms_graph_refresh_token', {
      p_user_id: userId,
      p_refresh_token: tokens.refresh_token
    });
  }

  return tokens.access_token;
}

async function logApiCall(
  tenantId: string | null,
  correlationId: string, 
  userId: string | null, 
  endpoint: string, 
  method: string, 
  status: 'success' | 'failure' | 'retry', 
  httpStatus: number, 
  errorMessage?: string
) {
  await supabase.rpc('log_graph_api_call', {
    p_tenant_id: tenantId,
    p_correlation_id: correlationId,
    p_invoked_by: userId,
    p_endpoint: endpoint,
    p_http_method: method,
    p_status: status,
    p_http_status: httpStatus,
    p_error_message: errorMessage || null
  });
}

Deno.serve(async (req) => {
  const correlationId = crypto.randomUUID();
  let tenantId = null;
  let userId = null;

  try {
    if (req.method === 'OPTIONS') {
      return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })
    }

    const reqData = await req.json();
    const { recipient, subject, content, attachments = [], correlation_id: providedCorrId, ms_access_token } = reqData;
    const finalCorrId = providedCorrId || correlationId;

    let accessToken = ms_access_token;

    if (!accessToken) {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return new Response(JSON.stringify({ error: 'Missing Authorization header' }), { status: 401 })

      const { data: { user }, error: userError } = await supabase.auth.getUser(authHeader.replace('Bearer ', ''))
      if (userError || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 })
      
      userId = user.id;

      const { data: membership } = await supabase.from('memberships').select('tenant_id, ms_access_token').eq('user_id', user.id).limit(1).maybeSingle();
      if (membership?.tenant_id) {
          tenantId = membership.tenant_id;
      }
      
      if (membership?.ms_access_token) {
          accessToken = membership.ms_access_token;
      } else {
          accessToken = await getOrRefreshToken(user.id);
      }
    }

    if (!recipient || !subject || !content) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
    }

    const { data: contact } = await supabase
      .from('contacts')
      .select('status')
      .eq('tenant_id', tenantId)
      .eq('email', recipient)
      .single()
    
    if (!tenantId) {
      return new Response(JSON.stringify({ error: 'No tenant configured' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
    }
    
    if (contact?.status === 'hardbounced') {
      return new Response(JSON.stringify({ error: 'Contact is hardbounced, cannot send' }), { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } })
    }

    let emailStatus: 'sent' | 'failed' = 'failed';
    let errorDetail = null;
    let actualAttachmentSize = 0;

    try {
      if (attachments.length === 0) {
        // Send without attachment
        const payload = {
          message: {
            subject,
            body: { contentType: "HTML", content: content.replace(/\n/g, '<br>') },
            toRecipients: [{ emailAddress: { address: recipient } }]
          },
          saveToSentItems: "true"
        };
        const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
          method: "POST",
          headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        
        await logApiCall(tenantId, finalCorrId, userId, "/me/sendMail", "POST", resp.ok ? "success" : "failure", resp.status, !resp.ok ? await resp.text() : undefined);
        
        if (!resp.ok) throw new Error("Failed to send simple email");
        emailStatus = 'sent';

      } else {
        // Download all attachments from Supabase Storage
        const downloadedFiles = [];
        for (const att of attachments) {
          const { data: fileData, error: downloadError } = await supabase.storage.from('dfsdfsdf').download(att.path);
          if (downloadError || !fileData) {
            throw new Error(`Failed to download ${att.name} from Supabase Storage: ${downloadError?.message}`);
          }
          const arrayBuffer = await fileData.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          actualAttachmentSize += bytes.byteLength;
          downloadedFiles.push({
            name: att.name,
            bytes: bytes,
            size: bytes.byteLength
          });
        }

        const MB_3 = 3 * 1024 * 1024;
        
        // Use Draft + Upload Session if size > 3MB
        if (actualAttachmentSize > MB_3) {
          const draftResp = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              subject,
              toRecipients: [{ emailAddress: { address: recipient } }],
              body: { contentType: "HTML", content: content.replace(/\n/g, '<br>') }
            })
          });
          const draft = await draftResp.json();
          await logApiCall(tenantId, finalCorrId, userId, "/me/messages", "POST", draftResp.ok ? "success" : "failure", draftResp.status, !draftResp.ok ? JSON.stringify(draft) : undefined);
          if (!draftResp.ok) throw new Error("Failed to create draft");
          
          const messageId = draft.id;

          for (const file of downloadedFiles) {
            const sessionResp = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/attachments/createUploadSession`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ AttachmentItem: { attachmentType: "file", name: file.name, size: file.size } })
            });
            const session = await sessionResp.json();
            if (!sessionResp.ok) throw new Error("Failed to create upload session");

            const uploadUrl = session.uploadUrl;
            const CHUNK_SIZE = 320 * 1024;
            
            for (let start = 0; start < file.size; start += CHUNK_SIZE) {
              const end = Math.min(start + CHUNK_SIZE - 1, file.size - 1);
              const chunk = file.bytes.slice(start, end + 1);
              
              const upResp = await fetch(uploadUrl, {
                method: "PUT",
                headers: {
                  "Content-Length": `${chunk.byteLength}`,
                  "Content-Range": `bytes ${start}-${end}/${file.size}`
                },
                body: chunk
              });
              
              if (!upResp.ok) {
                 throw new Error(`Upload failed for ${file.name} at bytes ${start}-${end}`);
              }
            }
          }

          const sendResp = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/send`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}` }
          });
          
          if (!sendResp.ok) throw new Error("Failed to send message after upload.");
          emailStatus = 'sent';

        } else {
          // Send immediately inline
          const graphAttachments = downloadedFiles.map(f => ({
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: f.name,
            contentType: "application/octet-stream", 
            contentBytes: encodeBase64(f.bytes)
          }));

          const payload = {
            message: {
              subject,
              body: { contentType: "HTML", content: content.replace(/\n/g, '<br>') },
              toRecipients: [{ emailAddress: { address: recipient } }],
              attachments: graphAttachments
            },
            saveToSentItems: "true"
          };

          const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          await logApiCall(tenantId, finalCorrId, userId, "/me/sendMail", "POST", resp.ok ? "success" : "failure", resp.status, !resp.ok ? await resp.text() : undefined);

          if (!resp.ok) throw new Error("Failed to send email with small attachments");
          emailStatus = 'sent';
        }
      }
    } catch (e) {
      errorDetail = e instanceof Error ? e.message : 'Unknown error';
      emailStatus = 'failed';
    }

    // Log the email event with attachment metadata
    await supabase.rpc('log_email_event', {
      p_tenant_id: tenantId,
      p_correlation_id: finalCorrId,
      p_sent_by: userId,
      p_recipient: recipient,
      p_subject: subject,
      p_status: emailStatus,
      p_error_detail: errorDetail,
      p_metadata: { attachments, hasAttachment: attachments.length > 0, attachmentSize: actualAttachmentSize }
    });

    if (emailStatus === 'failed') {
      return new Response(JSON.stringify({ error: errorDetail }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
    }

    return new Response(JSON.stringify({ success: true, correlation_id: finalCorrId }), { status: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const status = message === 'RE_AUTH_REQUIRED' ? 403 : 500;
    return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
})