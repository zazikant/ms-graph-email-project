import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"
import { encodeBase64 } from "jsr:@std/encoding/base64"

Deno.serve(async (req) => {
  const CRON_SECRET = Deno.env.get("CRON_SECRET")
  if (CRON_SECRET) {
    const authHeader = req.headers.get("Authorization")
    if (authHeader !== `Bearer ${CRON_SECRET}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
    }
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  const startTime = Date.now()
  const MAX_RUNTIME_MS = 120_000
  const results: {
    batch_id: string
    user_id: string
    sent: number
    failed: number
    skipped: number
    error?: string
  }[] = []

  try {
    const { data: batches, error: batchError } = await supabase.rpc("get_pending_batches")
    if (batchError) {
      return new Response(JSON.stringify({ error: batchError.message }), { status: 500 })
    }

    if (!batches || batches.length === 0) {
      return new Response(
        JSON.stringify({ message: "No pending batches", processed: 0, results: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    const userBatches = new Map<string, typeof batches>()
    for (const b of batches) {
      if (!b.user_id) continue
      if (!userBatches.has(b.user_id)) userBatches.set(b.user_id, [])
      userBatches.get(b.user_id)!.push(b)
    }

    const userCount = userBatches.size
    const timeSlicePerUser = Math.min(20_000, Math.floor(110_000 / userCount))

    for (const [userId, userBatchList] of userBatches) {
      const userStart = Date.now()

      const { data: linkData, error: linkError } = await supabase
        .from("user_ms_graph_links")
        .select("access_token, status, retry_after, processing_since, expires_at, send_count")
        .eq("user_id", userId)
        .maybeSingle()

      console.log("DEBUG linkData:", JSON.stringify({ userId, linkData, linkError: linkError?.message }))

      if (linkError || !linkData) {
        for (const b of userBatchList) {
          await supabase.from("batches").update({ status: "failed" }).eq("id", b.batch_id)
        }
        results.push({
          batch_id: userBatchList.map((b) => b.batch_id).join(","),
          user_id: userId,
          sent: 0,
          failed: 0,
          skipped: 0,
          error: "No token found for user",
        })
        continue
      }

      if (linkData.status === "token_expired") {
        for (const b of userBatchList) {
          await supabase.from("batches").update({ status: "failed" }).eq("id", b.batch_id)
        }
        results.push({
          batch_id: userBatchList.map((b) => b.batch_id).join(","),
          user_id: userId,
          sent: 0,
          failed: 0,
          skipped: 0,
          error: "Token expired",
        })
        continue
      }

      if (linkData.retry_after && new Date(linkData.retry_after) > new Date()) {
        results.push({
          batch_id: userBatchList.map((b) => b.batch_id).join(","),
          user_id: userId,
          sent: 0,
          failed: 0,
          skipped: 0,
          error: "Rate limited until " + linkData.retry_after,
        })
        continue
      }

      if (linkData.status === "processing") {
        if (linkData.processing_since && new Date(linkData.processing_since) > new Date(Date.now() - 2 * 60 * 60 * 1000)) {
          results.push({
            batch_id: userBatchList.map((b) => b.batch_id).join(","),
            user_id: userId,
            sent: 0,
            failed: 0,
            skipped: 0,
            error: "Already processing",
          })
          continue
        }
      }

      await supabase
        .from("user_ms_graph_links")
        .update({ status: "processing", processing_since: new Date().toISOString() })
        .eq("user_id", userId)

      const accessToken = linkData.access_token
      if (!accessToken) {
        await supabase.from("user_ms_graph_links").update({ status: "token_expired", processing_since: null }).eq("user_id", userId)
        for (const b of userBatchList) {
          await supabase.from("batches").update({ status: "failed" }).eq("id", b.batch_id)
        }
        results.push({
          batch_id: userBatchList.map((b) => b.batch_id).join(","),
          user_id: userId,
          sent: 0,
          failed: 0,
          skipped: 0,
          error: "Token unavailable",
        })
        continue
      }

      const { data: membership } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userId)
        .maybeSingle()
      const tenantId = membership?.tenant_id || null

      let tokenExpired = false
      let rateLimited = false

      for (const batch of userBatchList) {
        if (Date.now() - userStart > timeSlicePerUser) break
        if (tokenExpired || rateLimited) break

        await supabase
          .from("batches")
          .update({ status: "processing", started_at: new Date().toISOString() })
          .eq("id", batch.batch_id)

        const { data: recipients, error: recipientsError } = await supabase.rpc("get_pending_recipients", {
          p_batch_id: batch.batch_id,
        })
        if (recipientsError || !recipients || recipients.length === 0) {
          await supabase.rpc("update_batch_counts", { p_batch_id: batch.batch_id })
          continue
        }

        let batchSent = 0
        let batchFailed = 0
        let batchSkipped = 0
        const batchAttachments = (batch.attachments || []) as { name: string; path: string; size: number }[]

        let downloadedFiles: { name: string; bytes: Uint8Array; size: number }[] = []
        let totalAttachmentSize = 0
        try {
          for (const att of batchAttachments) {
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

        for (const recipient of recipients) {
          if (Date.now() - startTime > MAX_RUNTIME_MS) break
          if (tokenExpired || rateLimited) break

          const trackingId = recipient.tracking_id

          let emailSendId: string | null = null
          if (tenantId) {
            const { data: sendRow } = await supabase
              .from("email_sends")
              .insert({
                tenant_id: tenantId,
                tracking_id: trackingId,
                recipient_email: recipient.email,
                subject: batch.subject,
                html_content: batch.content,
                status: "processing",
                user_id: userId,
              })
              .select("id")
              .maybeSingle()
            if (sendRow) emailSendId = sendRow.id
          }

          const baseUrl = supabaseUrl
          const trackOpenUrl = baseUrl + "/functions/v1/track-open-v2?tid=" + trackingId
          const trackClickUrl = baseUrl + "/functions/v1/track-click-v2?tid=" + trackingId
          const trackingPixel = `<img src="${trackOpenUrl}" width="1" height="1" style="display:none" />`
          const wrappedContent =
            (batch.content as string).replace(/href="([^"]+)"/g, `href="${trackClickUrl}&url=$1"`) +
            trackingPixel

          let emailStatus: "sent" | "failed" = "failed"
          let errorDetail: string | null = null

          try {
            const MB_3 = 3 * 1024 * 1024

            if (downloadedFiles.length > 0 && totalAttachmentSize > MB_3) {
              const draftResp = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
                method: "POST",
                headers: {
                  Authorization: "Bearer " + accessToken,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  subject: batch.subject,
                  toRecipients: [{ emailAddress: { address: recipient.email } }],
                  body: { contentType: "HTML", content: wrappedContent },
                }),
              })
              const draft = await draftResp.json()
              if (!draftResp.ok) {
                if (draftResp.status === 401) {
                  tokenExpired = true
                  await supabase
                    .from("user_ms_graph_links")
                    .update({ status: "token_expired", processing_since: null })
                    .eq("user_id", userId)
                  break
                }
                throw new Error("Failed to create draft: " + JSON.stringify(draft))
              }
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
            } else {
              const graphAttachments = downloadedFiles.map((f) => ({
                "@odata.type": "#microsoft.graph.fileAttachment",
                name: f.name,
                contentType: "application/octet-stream",
                contentBytes: encodeBase64(f.bytes),
              }))

              const payload: Record<string, unknown> = {
                message: {
                  subject: batch.subject,
                  body: { contentType: "HTML", content: wrappedContent },
                  toRecipients: [{ emailAddress: { address: recipient.email } }],
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
                tokenExpired = true
                await supabase
                  .from("user_ms_graph_links")
                  .update({ status: "token_expired", processing_since: null })
                  .eq("user_id", userId)
                break
              }

              if (resp.status === 429) {
                rateLimited = true
                const retryAfterHeader = resp.headers.get("Retry-After")
                const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader) : 3600
                const retryAfterDate = new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
                await supabase
                  .from("user_ms_graph_links")
                  .update({ retry_after: retryAfterDate, status: "active", processing_since: null })
                  .eq("user_id", userId)
                break
              }

              if (!resp.ok) {
                const errText = await resp.text()
                throw new Error("Graph API Error: " + errText)
              }

              emailStatus = "sent"
            }
          } catch (e) {
            errorDetail = e instanceof Error ? e.message : "Unknown error"
            emailStatus = "failed"
          }

          if (emailStatus === "sent") {
            batchSent++
            await supabase
              .from("recipient_list")
              .update({ status: "sent" })
              .eq("id", recipient.id)
            if (emailSendId) {
              await supabase
                .from("email_sends")
                .update({ status: "sent", sent_at: new Date().toISOString() })
                .eq("id", emailSendId)
              if (batchAttachments.length > 0) {
                const attRows = batchAttachments.map((a) => ({
                  send_id: emailSendId,
                  file_name: a.name,
                  storage_path: a.path,
                  file_size: a.size,
                }))
                await supabase.from("send_attachments").insert(attRows)
              }
            }
            await supabase.rpc("increment_send_count", { p_user_id: userId })
          } else {
            batchFailed++
            await supabase
              .from("recipient_list")
              .update({ status: "failed", error_detail: errorDetail })
              .eq("id", recipient.id)
            if (emailSendId) {
              await supabase
                .from("email_sends")
                .update({ status: "failed", failure_reason: errorDetail })
                .eq("id", emailSendId)
            }
          }

          if (tenantId) {
            await supabase.rpc("log_email_event", {
              p_tenant_id: tenantId,
              p_correlation_id: trackingId,
              p_sent_by: userId,
              p_recipient: recipient.email,
              p_subject: batch.subject,
              p_status: emailStatus,
              p_error_detail: errorDetail,
              p_metadata: { batch_id: batch.batch_id, hasAttachment: batchAttachments.length > 0 },
            })
          }

          await new Promise((r) => setTimeout(r, 200))
        }

        await supabase.rpc("update_batch_counts", { p_batch_id: batch.batch_id })
        results.push({
          batch_id: batch.batch_id,
          user_id: userId,
          sent: batchSent,
          failed: batchFailed,
          skipped: batchSkipped,
        })
      }

      if (!tokenExpired && !rateLimited) {
        await supabase
          .from("user_ms_graph_links")
          .update({ status: "active", processing_since: null })
          .eq("user_id", userId)
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
