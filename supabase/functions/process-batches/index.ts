import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"
import { encodeBase64 } from "jsr:@std/encoding/base64"

interface OAuthConfig {
  clientId: string
  clientSecret: string
  tenantId: string
  authorityHost: string
  source: "user" | "tenant" | "environment" | "none"
}

/**
 * 3-tier lookup: per-user -> per-tenant -> env.
 * Inlined to avoid cross-function import map dependencies.
 */
async function getOAuthConfig(
  supabase: ReturnType<typeof createClient>,
  userId: string
): Promise<OAuthConfig | null> {
  const { data: row, error: rpcErr } = await supabase.rpc("get_effective_azure_config", {
    p_user_id: userId,
  })

  if (!rpcErr && row && row.length > 0 && row[0].client_id) {
    let secret = ""
    if (row[0].source === "user") {
      const { data: ul } = await supabase
        .from("user_ms_graph_links")
        .select("ms_client_secret")
        .eq("user_id", userId)
        .maybeSingle()
      secret = ul?.ms_client_secret ?? ""
    } else {
      const { data: m } = await supabase
        .from("memberships")
        .select("tenant_id")
        .eq("user_id", userId)
        .maybeSingle()
      if (m?.tenant_id) {
        const { data: t } = await supabase
          .from("tenants")
          .select("ms_client_secret")
          .eq("id", m.tenant_id)
          .maybeSingle()
        secret = t?.ms_client_secret ?? ""
      }
    }
    return {
      clientId: row[0].client_id,
      clientSecret: secret,
      tenantId: row[0].microsoft_tenant_id,
      authorityHost: row[0].authority_host || "https://login.microsoftonline.com",
      source: row[0].source as "user" | "tenant",
    }
  }

  const envClientId = Deno.env.get("MS_CLIENT_ID")
  const envClientSecret = Deno.env.get("MS_CLIENT_SECRET")
  const envTenantId = Deno.env.get("MS_TENANT_ID")
  if (envClientId && envClientSecret && envTenantId) {
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      tenantId: envTenantId,
      authorityHost: Deno.env.get("MS_AUTHORITY_HOST") || "https://login.microsoftonline.com",
      source: "environment",
    }
  }

  return null
}

/**
 * Token refresh helper — uses refresh_token (if available) + per-user/per-tenant
 * OAuth credentials to obtain a new access token from Microsoft Entra ID.
 *
 * Falls back gracefully if no refresh_token or credentials exist.
 * Returns { access_token, refresh_token?, expires_at? } on success, null on failure.
 */
async function tryRefreshToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  currentRefreshToken: string | null
): Promise<{ access_token: string; refresh_token?: string; expires_at?: string } | null> {
  // Need a refresh token to proceed
  if (!currentRefreshToken) {
    console.log(`[tryRefreshToken] No refresh_token for user ${userId}, cannot auto-refresh`)
    return null
  }

  // Resolve OAuth config (per-user -> per-tenant -> env)
  const oauthConfig = await getOAuthConfig(supabase, userId)
  if (!oauthConfig) {
    console.log(`[tryRefreshToken] No OAuth config for user ${userId} (per-user/per-tenant/env all empty)`)
    return null
  }

  // Attempt token refresh via Microsoft Entra ID
  const tokenUrl = `${oauthConfig.authorityHost}/${oauthConfig.tenantId}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id: oauthConfig.clientId,
    client_secret: oauthConfig.clientSecret,
    grant_type: "refresh_token",
    refresh_token: currentRefreshToken,
    scope: "https://graph.microsoft.com/.default offline_access",
  })

  try {
    const resp = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    })

    const tokens = await resp.json()

    if (!resp.ok) {
      if (tokens.error === "invalid_grant") {
        console.log(`[tryRefreshToken] Refresh token expired/revoked for user ${userId} — re-auth required`)
        // Mark as needing re-auth
        await supabase
          .from("user_ms_graph_links")
          .update({ status: "token_expired", processing_since: null, refresh_token: null })
          .eq("user_id", userId)
        return null
      }
      console.error(`[tryRefreshToken] Token refresh failed: ${tokens.error} — ${tokens.error_description}`)
      return null
    }

    // Calculate expiry time (typically 60-90 min, subtract 5 min safety margin)
    const expiresInSec = tokens.expires_in || 3600
    const expiresAt = new Date(Date.now() + (expiresInSec - 300) * 1000).toISOString()

    // Rotate refresh token if Microsoft returned a new one
    const newRefreshToken = tokens.refresh_token || currentRefreshToken

    // Update stored tokens
    await supabase
      .from("user_ms_graph_links")
      .update({
        access_token: tokens.access_token,
        refresh_token: newRefreshToken,
        expires_at: expiresAt,
        status: "active",
        processing_since: null,
      })
      .eq("user_id", userId)

    console.log(`[tryRefreshToken] Token refreshed successfully for user ${userId}, expires_at: ${expiresAt}`)
    return {
      access_token: tokens.access_token,
      refresh_token: newRefreshToken,
      expires_at: expiresAt,
    }
  } catch (err) {
    console.error(`[tryRefreshToken] Network error during refresh: ${err}`)
    return null
  }
}

/**
 * Decode JWT exp claim without external libraries.
 * Returns the expiry timestamp in milliseconds, or null if parsing fails.
 */
function getTokenExpiry(token: string): number | null {
  try {
    const parts = token.split(".")
    if (parts.length !== 3) return null
    // base64url decode
    const payload = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"))
    const decoded = JSON.parse(payload)
    if (decoded.exp) return decoded.exp * 1000 // exp is in seconds
    return null
  } catch {
    return null
  }
}

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
        .select("access_token, status, retry_after, processing_since, expires_at, send_count, refresh_token")
        .eq("user_id", userId)
        .maybeSingle()

      console.log("DEBUG linkData:", JSON.stringify({ userId, hasAccessToken: !!linkData?.access_token, hasRefreshToken: !!linkData?.refresh_token, status: linkData?.status, expiresAt: linkData?.expires_at, linkError: linkError?.message }))

      if (linkError || !linkData) {
        // FIX #1: No token found — keep batches as pending (not failed) so they retry when user adds token
        console.log(`[process-batches] No token row for user ${userId} — skipping, batches stay pending`)
        results.push({
          batch_id: userBatchList.map((b) => b.batch_id).join(","),
          user_id: userId,
          sent: 0,
          failed: 0,
          skipped: 0,
          error: "No token found for user — batches remain pending",
        })
        continue
      }

      // FIX #2: token_expired — try auto-refresh FIRST, then skip if no refresh_token
      if (linkData.status === "token_expired") {
        console.log(`[process-batches] Token expired for user ${userId} — attempting auto-refresh`)

        const refreshed = await tryRefreshToken(supabase, userId, linkData.refresh_token)
        if (refreshed) {
          // Token refreshed — update linkData and continue processing
          linkData.access_token = refreshed.access_token
          linkData.refresh_token = refreshed.refresh_token || linkData.refresh_token
          linkData.expires_at = refreshed.expires_at || linkData.expires_at
          linkData.status = "active"
          console.log(`[process-batches] Auto-refresh succeeded for user ${userId} — proceeding with batches`)
        } else {
          // Cannot refresh — skip user, keep batches as pending (NOT failed)
          console.log(`[process-batches] Auto-refresh failed for user ${userId} — skipping, batches remain pending`)
          results.push({
            batch_id: userBatchList.map((b) => b.batch_id).join(","),
            user_id: userId,
            sent: 0,
            failed: 0,
            skipped: 0,
            error: "Token expired — auto-refresh unavailable, batches remain pending until user updates token",
          })
          continue
        }
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

      // FIX #3: Proactive expiry check — if token expires within 5 minutes, try refresh first
      let accessToken = linkData.access_token
      let currentRefreshToken = linkData.refresh_token || null
      const now = Date.now()
      const SAFETY_MARGIN_MS = 5 * 60 * 1000 // 5 minutes before expiry

      // Check expires_at from DB first, then fall back to JWT decode
      let tokenExpiresAt: number | null = null
      if (linkData.expires_at) {
        tokenExpiresAt = new Date(linkData.expires_at).getTime()
      } else if (accessToken) {
        tokenExpiresAt = getTokenExpiry(accessToken)
        // If we decoded exp from JWT, store it for future checks
        if (tokenExpiresAt) {
          await supabase
            .from("user_ms_graph_links")
            .update({ expires_at: new Date(tokenExpiresAt).toISOString() })
            .eq("user_id", userId)
        }
      }

      if (tokenExpiresAt && (tokenExpiresAt - now) < SAFETY_MARGIN_MS) {
        console.log(`[process-batches] Token for user ${userId} expires soon (at ${new Date(tokenExpiresAt).toISOString()}) — attempting proactive refresh`)
        const refreshed = await tryRefreshToken(supabase, userId, currentRefreshToken)
        if (refreshed) {
          accessToken = refreshed.access_token
          currentRefreshToken = refreshed.refresh_token || currentRefreshToken
          console.log(`[process-batches] Proactive refresh succeeded for user ${userId}`)
        } else {
          // Can't refresh — if token is already expired, skip
          if (tokenExpiresAt <= now) {
            console.log(`[process-batches] Token already expired for user ${userId} and refresh failed — skipping`)
            await supabase
              .from("user_ms_graph_links")
              .update({ status: "token_expired", processing_since: null })
              .eq("user_id", userId)
            results.push({
              batch_id: userBatchList.map((b) => b.batch_id).join(","),
              user_id: userId,
              sent: 0,
              failed: 0,
              skipped: 0,
              error: "Token expired — refresh unavailable, batches remain pending",
            })
            continue
          }
          // Token not expired yet but will expire during processing — proceed with caution
          console.log(`[process-batches] Token for user ${userId} expires soon but refresh unavailable — proceeding anyway`)
        }
      }

      await supabase
        .from("user_ms_graph_links")
        .update({ status: "processing", processing_since: new Date().toISOString() })
        .eq("user_id", userId)

      if (!accessToken) {
        await supabase.from("user_ms_graph_links").update({ status: "token_expired", processing_since: null }).eq("user_id", userId)
        // FIX: Don't fail batches — keep them pending
        results.push({
          batch_id: userBatchList.map((b) => b.batch_id).join(","),
          user_id: userId,
          sent: 0,
          failed: 0,
          skipped: 0,
          error: "Token unavailable — batches remain pending",
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
        if (Date.now() - userStart > timeSlicePerUser) {
          // Time slice expired — revert batch to pending so next cron run picks it up
          await supabase.rpc("update_batch_counts", { p_batch_id: batch.batch_id })
          const { data: batchCheck } = await supabase
            .from("batches")
            .select("sent_count, total_count")
            .eq("id", batch.batch_id)
            .maybeSingle()
          if (batchCheck && batchCheck.sent_count < batchCheck.total_count) {
            await supabase
              .from("batches")
              .update({ status: "pending" })
              .eq("id", batch.batch_id)
            console.log(`[process-batches] Time slice expired — batch ${batch.batch_id} reverted to pending (${batchCheck.sent_count}/${batchCheck.total_count} sent)`)
          }
          break
        }
        if (tokenExpired || rateLimited) break

        // ─── Retry cap (mirrors process-scheduled-individual L97) ──────────
        // The auto-resume-batches sweeper (migration 20260611120100)
        // increments retry_count every time it resurrects a stuck 'processing'
        // batch. After 3 attempts we give up and mark 'failed' so the user
        // can see the broken batch in the Batches tab and re-send manually.
        const MAX_BATCH_RETRIES = 3
        if ((batch.retry_count ?? 0) >= MAX_BATCH_RETRIES) {
          console.log(`[process-batches] batch ${batch.batch_id} exceeded retry cap (${batch.retry_count}) — marking failed`)
          await supabase
            .from("batches")
            .update({
              status: "failed",
              last_error: `max retries exceeded (${MAX_BATCH_RETRIES})`,
              completed_at: new Date().toISOString(),
            })
            .eq("id", batch.batch_id)
          continue
        }

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
          if (Date.now() - startTime > MAX_RUNTIME_MS) {
            // Global timeout — break and let the post-loop logic revert batch to pending
            console.log(`[process-batches] Global runtime limit reached at ${batchSent + batchFailed}/${recipients.length} recipients for batch ${batch.batch_id}`)
            break
          }
          if (tokenExpired || rateLimited) break

          const trackingId = recipient.tracking_id

          let contactName = recipient.email.split('@')[0]
          if (tenantId) {
            const { data: contact } = await supabase
              .from('contacts')
              .select('name')
              .eq('tenant_id', tenantId)
              .eq('email', recipient.email)
              .maybeSingle()
            if (contact?.name) {
              contactName = contact.name
            }
          }
          const personalizedContent = (batch.content as string).replace(/\{name\}/gi, contactName)

          let emailSendId: string | null = null
          if (tenantId) {
            const { data: sendRow } = await supabase
              .from("email_sends")
              .insert({
                tenant_id: tenantId,
                tracking_id: trackingId,
                recipient_email: recipient.email,
                subject: batch.subject,
                html_content: personalizedContent,
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
            personalizedContent.replace(/href="([^"]+)"/g, `href="${trackClickUrl}&url=$1"`) +
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
                  // FIX #4: On 401 mid-batch, try to refresh the token and retry
                  console.log(`[process-batches] 401 during draft creation for user ${userId} — attempting mid-batch refresh`)
                  const refreshed = await tryRefreshToken(supabase, userId, currentRefreshToken)
                  if (refreshed) {
                    accessToken = refreshed.access_token
                    currentRefreshToken = refreshed.refresh_token || currentRefreshToken
                    // Retry the draft creation with new token
                    const retryDraftResp = await fetch("https://graph.microsoft.com/v1.0/me/messages", {
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
                    const retryDraft = await retryDraftResp.json()
                    if (retryDraftResp.ok) {
                      // Success on retry — continue with this draft
                      const messageId = retryDraft.id
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
                      // Retry also failed with non-401
                      throw new Error("Failed to create draft on retry: " + JSON.stringify(retryDraft))
                    }
                  } else {
                    // Cannot refresh — mark token expired but keep batches PENDING
                    tokenExpired = true
                    await supabase
                      .from("user_ms_graph_links")
                      .update({ status: "token_expired", processing_since: null })
                      .eq("user_id", userId)
                    break
                  }
                } else {
                  throw new Error("Failed to create draft: " + JSON.stringify(draft))
                }
              } else {
                // Draft creation succeeded on first try
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
                // FIX #4: On 401 mid-batch, try to refresh the token and retry
                console.log(`[process-batches] 401 during sendMail for user ${userId} — attempting mid-batch refresh`)
                const refreshed = await tryRefreshToken(supabase, userId, currentRefreshToken)
                if (refreshed) {
                  accessToken = refreshed.access_token
                  currentRefreshToken = refreshed.refresh_token || currentRefreshToken
                  // Retry the sendMail with new token
                  const retryResp = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
                    method: "POST",
                    headers: {
                      Authorization: "Bearer " + accessToken,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(payload),
                  })
                  if (retryResp.status === 401) {
                    // Still 401 after refresh — give up for this user
                    tokenExpired = true
                    await supabase
                      .from("user_ms_graph_links")
                      .update({ status: "token_expired", processing_since: null })
                      .eq("user_id", userId)
                    break
                  }
                  if (retryResp.status === 429) {
                    rateLimited = true
                    const retryAfterHeader = retryResp.headers.get("Retry-After")
                    const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader) : 3600
                    const retryAfterDate = new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
                    await supabase
                      .from("user_ms_graph_links")
                      .update({ retry_after: retryAfterDate, status: "active", processing_since: null })
                      .eq("user_id", userId)
                    break
                  }
                  if (!retryResp.ok) {
                    const errText = await retryResp.text()
                    throw new Error("Graph API Error on retry: " + errText)
                  }
                  emailStatus = "sent"
                } else {
                  // Cannot refresh — mark token expired but keep batches PENDING
                  tokenExpired = true
                  await supabase
                    .from("user_ms_graph_links")
                    .update({ status: "token_expired", processing_since: null })
                    .eq("user_id", userId)
                  break
                }
              } else if (resp.status === 429) {
                rateLimited = true
                const retryAfterHeader = resp.headers.get("Retry-After")
                const retryAfterSeconds = retryAfterHeader ? parseInt(retryAfterHeader) : 3600
                const retryAfterDate = new Date(Date.now() + retryAfterSeconds * 1000).toISOString()
                await supabase
                  .from("user_ms_graph_links")
                  .update({ retry_after: retryAfterDate, status: "active", processing_since: null })
                  .eq("user_id", userId)
                break
              } else if (!resp.ok) {
                const errText = await resp.text()
                throw new Error("Graph API Error: " + errText)
              } else {
                emailStatus = "sent"
              }
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

          // 10 messages/minute = 6 seconds per message to avoid Exchange Online outbound spam blocks (AS(42004))
          await new Promise((r) => setTimeout(r, 6000))
        }

        // FIX #5: If batch incomplete (timeout, token expired, rate limited), 
        // set batch back to pending so remaining recipients can be sent on next cron run
        await supabase.rpc("update_batch_counts", { p_batch_id: batch.batch_id })
        const { data: batchCheck } = await supabase
          .from("batches")
          .select("sent_count, failed_count, total_count")
          .eq("id", batch.batch_id)
          .maybeSingle()
        
        if (batchCheck && (batchCheck.sent_count + batchCheck.failed_count) < batchCheck.total_count) {
          // Batch still has unsent recipients — revert to pending for next cron run
          const reason = tokenExpired ? "token expired" : rateLimited ? "rate limited" : "timeout/partial"
          await supabase
            .from("batches")
            .update({ status: "pending" })
            .eq("id", batch.batch_id)
          console.log(`[process-batches] Batch ${batch.batch_id} reverted to pending (${reason}: ${batchCheck.sent_count}/${batchCheck.total_count} sent)`)
        }

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
