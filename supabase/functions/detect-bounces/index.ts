import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

/**
 * detect-bounces Edge Function
 *
 * Reads the sender's Microsoft 365 inbox for NDR (Non-Delivery Report) messages,
 * parses the failed recipient addresses, and marks those contacts as "hardbounced"
 * so they are excluded from future batch sends.
 *
 * This closes the gap where MS Graph sendMail returns 202 Accepted but the
 * recipient's mail server bounces the email later — the NDR arrives in the
 * sender's inbox, which no part of the system previously checked.
 *
 * Should be called via cron after each batch run, or on a periodic schedule.
 *
 * Required env vars:
 * - SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY
 * - CRON_SECRET (for auth)
 */

// Common NDR diagnostic codes from Exchange Online
const PERMANENT_BOUNCE_CODES = [
  "5.1.1",    // Mailbox does not exist
  "5.1.6",    // Recipient not found
  "5.2.1",    // Mailbox disabled
  "5.2.2",    // Mailbox full (permanent)
  "5.4.1",    // Recipient address rejected
  "5.4.4",    // No route to host
  "5.4.6",    // Routing loop detected
  "5.5.0",    // 550 Requested action not taken
  "5.6.1",    // Content type not supported
  "5.7.1",    // Delivery not authorized (permanent policy)
  "5.7.133",  // Recipient not allowed
  "5.7.134",  // Sender not accepted
  "5.7.135",  // Recipient rejected
  "5.7.1-024", // Sender DMARC policy rejection
  "5.7.506",  // Access Denied, banned sending IP
  "5.7.509",  // Access denied, sending domain not verified
  "5.7.510",  // Access denied, app not in allowed list
]

const TRANSIENT_BOUNCE_CODES = [
  "4.3.1",    // Insufficient system resources
  "4.3.2",    // System not accepting messages
  "4.4.1",    // Connection timed out
  "4.4.2",    // Connection dropped
  "4.4.7",    // Message expired
  "4.7.0",    // Temporary message rejected
  "5.2.0",    // Mailbox unavailable (transient)
  "5.2.3",    // Message too large
  "5.3.0",    // Mail system full
  "5.4.0",    // DNS lookup failure
  "5.7.1-023", // Sender IP rate limited
]

/**
 * Try to refresh the access token using the stored refresh token
 */
async function tryRefreshToken(
  supabase: ReturnType<typeof createClient>,
  userId: string,
  currentRefreshToken: string | null
): Promise<{ access_token: string; refresh_token?: string } | null> {
  if (!currentRefreshToken) return null

  const { data: membership } = await supabase
    .from("memberships")
    .select("tenant_id")
    .eq("user_id", userId)
    .maybeSingle()

  if (!membership?.tenant_id) return null

  const { data: tenant } = await supabase
    .from("tenants")
    .select("ms_client_id, ms_client_secret, ms_tenant_id")
    .eq("id", membership.tenant_id)
    .maybeSingle()

  if (!tenant?.ms_client_id || !tenant?.ms_client_secret || !tenant?.ms_tenant_id) return null

  const tokenUrl = `https://login.microsoftonline.com/${tenant.ms_tenant_id}/oauth2/v2.0/token`
  const body = new URLSearchParams({
    client_id: tenant.ms_client_id,
    client_secret: tenant.ms_client_secret,
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
    if (!resp.ok) return null

    const expiresInSec = tokens.expires_in || 3600
    const expiresAt = new Date(Date.now() + (expiresInSec - 300) * 1000).toISOString()
    const newRefreshToken = tokens.refresh_token || currentRefreshToken

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

    return { access_token: tokens.access_token, refresh_token: newRefreshToken }
  } catch {
    return null
  }
}

/**
 * Extract failed recipient email from NDR message
 */
function extractFailedRecipient(message: any): { email: string; bounceCode: string } | null {
  const body = message.body?.content || ""
  const subject = message.subject || ""

  // Pattern 1: "Delivery has failed to these recipients" followed by email
  const recipientPattern = /Delivery has failed to these recipients or groups:\s*\n?\s*([^\s\n]+@[^\s\n]+)/i
  let match = body.match(recipientPattern)
  if (match) {
    const bounceCode = extractBounceCode(body) || "5.x.x"
    return { email: match[1].replace(/[<>]/g, "").toLowerCase(), bounceCode }
  }

  // Pattern 2: "Recipient: <email>" in NDR body
  const recipientPattern2 = /Recipient[^\n]*?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
  match = body.match(recipientPattern2)
  if (match) {
    const bounceCode = extractBounceCode(body) || "5.x.x"
    return { email: match[1].toLowerCase(), bounceCode }
  }

  // Pattern 3: Email in angle brackets after "to" in subject
  const subjectPattern = /Undeliverable:.*[<"]([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})[>"]/i
  match = subject.match(subjectPattern)
  if (match) {
    const bounceCode = extractBounceCode(body) || "5.x.x"
    return { email: match[1].toLowerCase(), bounceCode }
  }

  // Pattern 4: Any email in body that matches "failed" or "undeliverable" context
  const failedPattern = /(?:failed|undeliverable|rejected|bounced)[^\n]{0,100}?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i
  match = body.match(failedPattern)
  if (match) {
    const bounceCode = extractBounceCode(body) || "5.x.x"
    return { email: match[1].toLowerCase(), bounceCode }
  }

  return null
}

/**
 * Extract enhanced status code from NDR body
 */
function extractBounceCode(body: string): string | null {
  // Pattern: #5.x.x or 5.x.x
  const codePattern = /#(\d\.\d\.\d+)/
  const match = body.match(codePattern)
  if (match) return match[1]

  // Pattern: Status: 5.x.x
  const statusPattern = /Status:\s*(\d\.\d\.\d+)/i
  const statusMatch = body.match(statusPattern)
  if (statusMatch) return statusMatch[1]

  // Pattern: DSN code
  const dsnPattern = /DSN\s*(\d\.\d\.\d+)/i
  const dsnMatch = body.match(dsnPattern)
  if (dsnMatch) return dsnMatch[1]

  return null
}

/**
 * Determine if a bounce code is permanent or transient
 */
function isPermanentBounce(bounceCode: string): boolean {
  // 5.x.x = permanent failure, 4.x.x = transient
  if (bounceCode.startsWith("4.")) return false
  if (bounceCode.startsWith("5.")) {
    // Check if it's a known transient code
    const isTransient = TRANSIENT_BOUNCE_CODES.some(code => bounceCode.startsWith(code))
    if (isTransient) return false
    // Check if it's a known permanent code
    const isPermanent = PERMANENT_BOUNCE_CODES.some(code => bounceCode.startsWith(code))
    if (isPermanent) return true
    // Default: 5.x.x without known code = treat as permanent
    return true
  }
  return false
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

  const results: {
    user_id: string
    ndrs_found: number
    hardbounced: string[]
    softbounced: string[]
    errors: string[]
  }[] = []

  try {
    // Get all users with active tokens
    const { data: tokenUsers, error: tokenError } = await supabase
      .from("user_ms_graph_links")
      .select("user_id, access_token, refresh_token, expires_at, status")
      .not("access_token", "is", null)

    if (tokenError || !tokenUsers || tokenUsers.length === 0) {
      return new Response(
        JSON.stringify({ message: "No users with tokens found", processed: 0, results: [] }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    }

    for (const tokenUser of tokenUsers) {
      const userId = tokenUser.user_id
      let accessToken = tokenUser.access_token
      let refreshToken = tokenUser.refresh_token

      const userResult: typeof results[0] = {
        user_id: userId,
        ndrs_found: 0,
        hardbounced: [],
        softbounced: [],
        errors: [],
      }

      // Check if token is expired, try refresh
      const expiresAt = tokenUser.expires_at ? new Date(tokenUser.expires_at).getTime() : 0
      if (expiresAt < Date.now()) {
        const refreshed = await tryRefreshToken(supabase, userId, refreshToken)
        if (refreshed) {
          accessToken = refreshed.access_token
          refreshToken = refreshed.refresh_token || refreshToken
        } else {
          userResult.errors.push("Token expired and refresh failed")
          results.push(userResult)
          continue
        }
      }

      // Read inbox for NDR messages (last 24 hours)
      // Microsoft Graph: GET /me/messages with filter for Undeliverable subject
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      const filterQuery = encodeURIComponent(
        `startsWith(subject, 'Undeliverable') and receivedDateTime ge ${oneDayAgo}`
      )

      try {
        const messagesResp = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages?$filter=${filterQuery}&$select=subject,body,receivedDateTime,from&$top=50&$orderby=receivedDateTime desc`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        )

        if (messagesResp.status === 401) {
          // Try refresh and retry
          const refreshed = await tryRefreshToken(supabase, userId, refreshToken)
          if (refreshed) {
            accessToken = refreshed.access_token
            const retryResp = await fetch(
              `https://graph.microsoft.com/v1.0/me/messages?$filter=${filterQuery}&$select=subject,body,receivedDateTime,from&$top=50&$orderby=receivedDateTime desc`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  "Content-Type": "application/json",
                },
              }
            )
            if (!retryResp.ok) {
              userResult.errors.push(`Graph API error after refresh: ${retryResp.status}`)
              results.push(userResult)
              continue
            }
            const retryData = await retryResp.json()
            await processNDRs(supabase, retryData.value || [], userId, userResult)
          } else {
            userResult.errors.push("Token expired, refresh failed")
            results.push(userResult)
            continue
          }
        } else if (!messagesResp.ok) {
          const errText = await messagesResp.text()
          userResult.errors.push(`Graph API error: ${messagesResp.status} - ${errText}`)
          results.push(userResult)
          continue
        } else {
          const messagesData = await messagesResp.json()
          await processNDRs(supabase, messagesData.value || [], userId, userResult)
        }

        // Also check for messages with "Delivery Status Notification" (DSN) or "failure" in subject
        const dsnFilter = encodeURIComponent(
          `(contains(subject, 'Delivery Status Notification') or contains(subject, 'failure notice') or contains(subject, 'Returned mail')) and receivedDateTime ge ${oneDayAgo}`
        )

        const dsnResp = await fetch(
          `https://graph.microsoft.com/v1.0/me/messages?$filter=${dsnFilter}&$select=subject,body,receivedDateTime,from&$top=50&$orderby=receivedDateTime desc`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
          }
        )

        if (dsnResp.ok) {
          const dsnData = await dsnResp.json()
          await processNDRs(supabase, dsnData.value || [], userId, userResult)
        }
      } catch (err) {
        userResult.errors.push(`Network error: ${err instanceof Error ? err.message : "Unknown"}`)
      }

      results.push(userResult)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return new Response(JSON.stringify({ error: message, results }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(
    JSON.stringify({
      processed: results.length,
      total_ndrs: results.reduce((sum, r) => sum + r.ndrs_found, 0),
      total_hardbounced: results.reduce((sum, r) => sum + r.hardbounced.length, 0),
      results,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  )
})

/**
 * Process NDR messages: extract bounced recipients and update contacts
 */
async function processNDRs(
  supabase: ReturnType<typeof createClient>,
  messages: any[],
  userId: string,
  userResult: { ndrs_found: number; hardbounced: string[]; softbounced: string[]; errors: string[] }
) {
  for (const message of messages) {
    const bounced = extractFailedRecipient(message)
    if (!bounced) {
      // NDR format not recognized — skip but count
      userResult.ndrs_found++
      continue
    }

    userResult.ndrs_found++
    const { email, bounceCode } = bounced

    // Get tenant for this user
    const { data: membership } = await supabase
      .from("memberships")
      .select("tenant_id")
      .eq("user_id", userId)
      .maybeSingle()

    if (!membership?.tenant_id) continue

    if (isPermanentBounce(bounceCode)) {
      // Hard bounce — mark contact as hardbounced
      const { error: updateError } = await supabase
        .from("contacts")
        .update({ status: "hardbounced" })
        .eq("tenant_id", membership.tenant_id)
        .eq("email", email)

      if (updateError) {
        userResult.errors.push(`Failed to mark ${email} as hardbounced: ${updateError.message}`)
      } else {
        userResult.hardbounced.push(email)
        console.log(`[detect-bounces] Marked ${email} as hardbounced (code: ${bounceCode})`)

        // Also update any recent email_sends for this recipient
        await supabase
          .from("email_sends")
          .update({ status: "bounced", failure_reason: `Bounced: ${bounceCode}` })
          .eq("recipient_email", email)
          .eq("status", "sent")
          .gte("sent_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      }
    } else {
      // Soft bounce — don't mark as hardbounced, just log
      userResult.softbounced.push(`${email} (${bounceCode})`)
      console.log(`[detect-bounces] Soft bounce for ${email} (code: ${bounceCode}) — not marking hardbounced`)

      // Increment a bounce counter on the contact (for tracking)
      // We don't change status for soft bounces
    }
  }
}
