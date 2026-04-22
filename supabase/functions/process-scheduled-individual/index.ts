import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"
import { encodeBase64 } from "jsr:@std/encoding/base64"

Deno.serve(async (req) => {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const startTime = Date.now()
  const MAX_RUNTIME_MS = 60_000
  const results: {
    send_id: string
    recipient: string
    status: string
    error?: string
  }[] = []

  try {
    const { data: scheduledEmails, error: fetchError } = await supabase
      .from("email_sends")
      .select("*")
      .eq("status", "scheduled")
      .lte("send_at", new Date().toISOString())
      .limit(50)

    if (fetchError) {
      return new Response(JSON.stringify({ error: fetchError.message }), { status: 500 })
    }

    if (!scheduledEmails || scheduledEmails.length === 0) {
      return new Response(
        JSON.stringify({ message: "No scheduled emails ready to send", processed: 0, results: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    const userIds = [...new Set(scheduledEmails.map((e) => e.user_id))]

    for (const userId of userIds) {
      if (Date.now() - startTime > MAX_RUNTIME_MS) break

      const userEmails = scheduledEmails.filter((e) => e.user_id === userId)

      const { data: linkData, error: linkError } = await supabase
        .from("user_ms_graph_links")
        .select("access_token, status, retry_after")
        .eq("user_id", userId)
        .maybeSingle()

      if (linkError || !linkData || !linkData.access_token) {
        for (const email of userEmails) {
          await supabase
            .from("email_sends")
            .update({ status: "failed", failure_reason: "No token available" })
            .eq("id", email.id)
        }
        results.push(
          ...userEmails.map((e) => ({
            send_id: e.id,
            recipient: e.recipient_email,
            status: "failed",
            error: "No token available",
          }))
        )
        continue
      }

      if (linkData.status === "token_expired") {
        for (const email of userEmails) {
          await supabase
            .from("email_sends")
            .update({ status: "failed", failure_reason: "Token expired" })
            .eq("id", email.id)
        }
        results.push(
          ...userEmails.map((e) => ({
            send_id: e.id,
            recipient: e.recipient_email,
            status: "failed",
            error: "Token expired",
          }))
        )
        continue
      }

      if (linkData.retry_after && new Date(linkData.retry_after) > new Date()) {
        continue
      }

      const accessToken = linkData.access_token

      for (const email of userEmails) {
        if (Date.now() - startTime > MAX_RUNTIME_MS) break

        let emailStatus: "sent" | "failed" = "failed"
        let errorDetail: string | null = null

        let contactName = email.recipient_email.split('@')[0]
        if (email.tenant_id) {
          const { data: contact } = await supabase
            .from('contacts')
            .select('name')
            .eq('tenant_id', email.tenant_id)
            .eq('email', email.recipient_email)
            .maybeSingle()
          if (contact?.name) {
            contactName = contact.name
          }
        }
        const personalizedContent = (email.html_content as string).replace(/\{name\}/gi, contactName)

        try {
          const baseUrl = supabaseUrl
          const trackOpenUrl = baseUrl + "/functions/v1/track-open-v2?tid=" + email.tracking_id
          const trackClickUrl = baseUrl + "/functions/v1/track-click-v2?tid=" + email.tracking_id
          const trackingPixel = `<img src="${trackOpenUrl}" width="1" height="1" style="display:none" />`
          const wrappedContent =
            personalizedContent.replace(/href="([^"]+)"/g, `href="${trackClickUrl}&url=$1"`) +
            trackingPixel

          let downloadedFiles: { name: string; bytes: Uint8Array; size: number }[] = []
          let totalAttachmentSize = 0
          try {
            for (const att of (email.attachments || [])) {
              const { data: fileData, error: downloadError } = await supabase.storage
                .from("dfsdfsdf")
                .download(att.path)
              if (downloadError || !fileData) continue
              const arrayBuffer = await fileData.arrayBuffer()
              const bytes = new Uint8Array(arrayBuffer)
              totalAttachmentSize += bytes.byteLength
              downloadedFiles.push({ name: att.name, bytes, size: bytes.byteLength })
            }
          } catch {
            // skip attachment download errors
          }

          const MB_3 = 3 * 1024 * 1024

          if (downloadedFiles.length > 0 && totalAttachmentSize > MB_3) {
            const draftResp = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                subject: email.subject,
                toRecipients: [{ emailAddress: { address: email.recipient_email } }],
                body: { contentType: "HTML", content: wrappedContent },
              }),
            })
            const draft = await draftResp.json()
            if (!draftResp.ok) {
              if (draftResp.status === 401) {
                await supabase
                  .from("user_ms_graph_links")
                  .update({ status: "token_expired" })
                  .eq("user_id", userId)
                await supabase
                  .from("email_sends")
                  .update({ status: "failed", failure_reason: "Token expired" })
                  .eq("id", email.id)
                emailStatus = "failed"
                errorDetail = "Token expired"
              } else {
                throw new Error("Failed to create draft: " + JSON.stringify(draft))
              }
            } else {
              const messageId = draft.id
              for (const file of downloadedFiles) {
                const sessionResp = await fetch(
                  "https://graph.microsoft.com/v1.0/me/messages/" + messageId + "/attachments/createUploadSession",
                  {
                    method: "POST",
                    headers: {
                      Authorization: "Bearer " + accessToken,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      AttachmentItem: { attachmentType: "file", name: file.name, size: file.size },
                    }),
                  }
                )
                const session = await sessionResp.json()
                if (!sessionResp.ok) throw new Error("Failed to create upload session")
                const uploadUrl = session.uploadUrl
                const CHUNK_SIZE = 320 * 1024
                for (let start = 0; start < file.size; start += CHUNK_SIZE) {
                  const end = Math.min(start + CHUNK_SIZE - 1, file.size - 1)
                  const chunk = file.bytes.slice(start, end + 1)
                  const upResp = await fetch(uploadUrl, {
                    method: "PUT",
                    headers: {
                      "Content-Length": String(chunk.byteLength),
                      "Content-Range": `bytes ${start}-${end}/${file.size}`,
                    },
                    body: chunk,
                  })
                  if (!upResp.ok) throw new Error("Upload failed for " + file.name)
                }
              }
              const sendResp = await fetch(
                "https://graph.microsoft.com/v1.0/me/messages/" + messageId + "/send",
                { method: "POST", headers: { Authorization: "Bearer " + accessToken } }
              )
              if (!sendResp.ok) throw new Error("Failed to send message after upload")
              emailStatus = "sent"
            }
          } else {
            const graphAttachments = downloadedFiles.map((f) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              name: f.name,
              contentType: "application/octet-stream",
              contentBytes: encodeBase64(f.bytes),
            }))

            const payload: Record<string, unknown> = {
              message: {
                subject: email.subject,
                body: { contentType: "HTML", content: wrappedContent },
                toRecipients: [{ emailAddress: { address: email.recipient_email } }],
                ...(graphAttachments.length > 0 ? { attachments: graphAttachments } : {}),
              },
              saveToSentItems: "true",
            }

            const resp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
              method: "POST",
              headers: {
                Authorization: "Bearer " + accessToken,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(payload),
            })

            if (resp.status === 401) {
              await supabase
                .from("user_ms_graph_links")
                .update({ status: "token_expired" })
                .eq("user_id", userId)
              await supabase
                .from("email_sends")
                .update({ status: "failed", failure_reason: "Token expired" })
                .eq("id", email.id)
              emailStatus = "failed"
              errorDetail = "Token expired"
            } else if (resp.status === 429) {
              const retryAfterHeader = resp.headers.get("Retry-After")
              const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader) : 3600
              const retryAfterDate = new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
              await supabase
                .from("user_ms_graph_links")
                .update({ retry_after: retryAfterDate })
                .eq("user_id", userId)
              await supabase
                .from("email_sends")
                .update({ failure_reason: "Rate limited by Microsoft Graph" })
                .eq("id", email.id)
              emailStatus = "failed"
              errorDetail = "Rate limited"
            } else if (!resp.ok) {
              const errText = await resp.text()
              errorDetail = "Graph API Error: " + errText
              await supabase
                .from("email_sends")
                .update({ status: "failed", failure_reason: errorDetail })
                .eq("id", email.id)
              emailStatus = "failed"
            } else {
              emailStatus = "sent"
              await supabase
                .from("email_sends")
                .update({ status: "sent", sent_at: new Date().toISOString() })
                .eq("id", email.id)
            }
          }
        } catch (e) {
          errorDetail = e instanceof Error ? e.message : "Unknown error"
          await supabase
            .from("email_sends")
            .update({ status: "failed", failure_reason: errorDetail })
            .eq("id", email.id)
          emailStatus = "failed"
        }

        if (emailStatus === "sent") {
          await supabase.rpc("increment_send_count", { p_user_id: userId })
          if ((email.attachments || []).length > 0) {
            const attRows = (email.attachments as { name: string; path: string; size: number }[]).map((a) => ({
              send_id: email.id,
              file_name: a.name,
              storage_path: a.path,
              file_size: a.size,
            }))
            await supabase.from("send_attachments").insert(attRows)
          }
        }

        if (email.tenant_id) {
          await supabase.rpc("log_email_event", {
            p_tenant_id: email.tenant_id,
            p_correlation_id: email.tracking_id,
            p_sent_by: userId,
            p_recipient: email.recipient_email,
            p_subject: email.subject,
            p_status: emailStatus,
            p_error_detail: errorDetail,
            p_metadata: { scheduled: true },
          })
        }

        results.push({
          send_id: email.id,
          recipient: email.recipient_email,
          status: emailStatus,
          error: errorDetail || undefined,
        })

        await new Promise((r) => setTimeout(r, 200))
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return new Response(JSON.stringify({ error: message, results }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(
    JSON.stringify({ processed: results.length, results }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
})
