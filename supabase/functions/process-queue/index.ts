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
    .single();

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

Deno.serve(async (req) => {
  // Allow OPTIONS
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type' } })
  }

  // Verify standard auth or service key auth
  const authHeader = req.headers.get('Authorization');
  if (authHeader !== `Bearer ${supabaseServiceKey}` && !authHeader?.includes('Bearer')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  try {
    // 1. Find scheduled batches that should start processing
    const { data: pendingBatches } = await supabase
      .from('batches')
      .select('id')
      .in('status', ['pending', 'scheduled'])
      .lte('scheduled_at', new Date().toISOString());
      
    if (pendingBatches && pendingBatches.length > 0) {
      const batchIds = pendingBatches.map(b => b.id);
      await supabase.from('batches').update({ status: 'processing', started_at: new Date().toISOString() }).in('id', batchIds);
    }

    // 2. Fetch a chunk of recipients to process (limit to 50 per execution to avoid timeouts)
    const { data: recipients, error: recipientsError } = await supabase
      .from('recipient_list')
      .select(`
        id, email, batch_id, 
        batches ( subject, content, sent_by, tenant_id, metadata )
      `)
      .eq('status', 'pending')
      .in('batches.status', ['processing'])
      .limit(50);

    if (recipientsError) {
      console.error('Error fetching recipients:', recipientsError);
    }

    let processedCount = 0;
    const userTokens: Record<string, string> = {};

    if (recipients && recipients.length > 0) {
      for (const rec of recipients) {
        if (!rec.batches) continue;
        
        // Handling arrays or single objects returned by PostgREST inner joins
        const batchData = Array.isArray(rec.batches) ? rec.batches[0] : rec.batches;
        const { subject, content, sent_by, tenant_id } = batchData;
        const attachments = batchData.metadata?.attachments || [];
        
        try {
          if (!userTokens[sent_by]) {
            const { data: mem } = await supabase.from('memberships').select('ms_access_token').eq('user_id', sent_by).limit(1).single();
            if (mem && mem.ms_access_token) {
              userTokens[sent_by] = mem.ms_access_token;
            } else {
              userTokens[sent_by] = await getOrRefreshToken(sent_by);
            }
          }
          const accessToken = userTokens[sent_by];

          // Download all attachments from Supabase Storage
          const downloadedFiles = [];
          let actualAttachmentSize = 0;
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
          
          if (attachments.length > 0 && actualAttachmentSize > MB_3) {
              const draftResp = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
                method: "POST",
                headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                  subject,
                  toRecipients: [{ emailAddress: { address: rec.email } }],
                  body: { contentType: "HTML", content: content.replace(/\n/g, '<br>') }
                })
              });
              const draft = await draftResp.json();
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
                  if (!upResp.ok) throw new Error(`Upload failed for ${file.name} at bytes ${start}-${end}`);
                }
              }

              const sendResp = await fetch(`https://graph.microsoft.com/v1.0/me/messages/${messageId}/send`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${accessToken}` }
              });
              
              if (!sendResp.ok) throw new Error("Failed to send message after upload.");

          } else {
             // Send immediately inline or with small attachments
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
                  toRecipients: [{ emailAddress: { address: rec.email } }],
                  ...(graphAttachments.length > 0 ? { attachments: graphAttachments } : {})
                },
                saveToSentItems: "true"
              };
              
              const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
                method: "POST",
                headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
                body: JSON.stringify(payload)
              });

if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`Graph API Error: ${errText}`);
              }
          }

          // Mark as sent
          await supabase.from('recipient_list').update({ status: 'sent' }).eq('id', rec.id);
          
          // Log to email_audit
          await supabase.rpc('log_email_event', {
            p_tenant_id: tenant_id,
            p_correlation_id: crypto.randomUUID(),
            p_sent_by: sent_by,
            p_recipient: rec.email,
            p_subject: subject,
            p_status: 'sent',
            p_error_detail: null,
            p_metadata: { batch_id: rec.batch_id }
          });
          
          // Increment counters
          await supabase.rpc('increment_batch_sent', { p_batch_id: rec.batch_id });

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Failed to send to ${rec.email}:`, error);
          await supabase.from('recipient_list').update({ status: 'failed', error_detail: errorMessage }).eq('id', rec.id);
          
          await supabase.rpc('log_email_event', {
            p_tenant_id: tenant_id,
            p_correlation_id: crypto.randomUUID(),
            p_sent_by: sent_by,
            p_recipient: rec.email,
            p_subject: subject,
            p_status: 'failed',
            p_error_detail: errorMessage,
            p_metadata: { batch_id: rec.batch_id }
          });
          
          await supabase.rpc('increment_batch_failed', { p_batch_id: rec.batch_id });
        }
        processedCount++;
        
        // Delay to avoid graph api limits
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // 3. Mark completed batches
    const { data: processingBatches } = await supabase
      .from('batches')
      .select('id, total_count, sent_count, failed_count')
      .eq('status', 'processing');
      
    if (processingBatches) {
      for (const b of processingBatches) {
        if (b.sent_count + b.failed_count >= b.total_count) {
          await supabase.from('batches').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', b.id);
        }
      }
    }

    // 4. Also process scheduled individual emails in email_audit
    const { data: scheduledEmails } = await supabase
      .from('email_audit')
      .select('id, recipient, subject, metadata, sent_by, tenant_id')
      .eq('status', 'pending')
      .not('scheduled_at', 'is', null)
      .lte('scheduled_at', new Date().toISOString())
      .limit(20);
      
    if (scheduledEmails && scheduledEmails.length > 0) {
      for (const email of scheduledEmails) {
        try {
          if (!userTokens[email.sent_by]) {
            const { data: mem } = await supabase.from('memberships').select('ms_access_token').eq('user_id', email.sent_by).limit(1).single();
            if (mem && mem.ms_access_token) {
              userTokens[email.sent_by] = mem.ms_access_token;
            } else {
              userTokens[email.sent_by] = await getOrRefreshToken(email.sent_by);
            }
          }
          const accessToken = userTokens[email.sent_by];
          
          const content = (email.metadata as Record<string, unknown>)?.content as string || ''; 
          
          const payload = {
            message: {
              subject: email.subject,
              body: { contentType: "Text", content },
              toRecipients: [{ emailAddress: { address: email.recipient } }]
            },
            saveToSentItems: "true"
          };
          
          const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
            method: "POST",
            headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
            body: JSON.stringify(payload)
          });

          if (!resp.ok) throw new Error(await resp.text());
          
          await supabase.from('email_audit').update({ status: 'sent', updated_at: new Date().toISOString() }).eq('id', email.id);

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await supabase.from('email_audit').update({ status: 'failed', error_detail: errorMessage, updated_at: new Date().toISOString() }).eq('id', email.id);
        }
        processedCount++;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    const hasMore = processedCount >= 50;

    return new Response(JSON.stringify({ success: true, processedCount, hasMore }), { 
      status: 200, 
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
    });

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), { 
      status: 500, 
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } 
    });
  }
});