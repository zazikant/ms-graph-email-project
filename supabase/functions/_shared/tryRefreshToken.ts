// supabase/functions/_shared/tryRefreshToken.ts
//
// Shared helper for Microsoft Entra ID token refresh. Used by
// process-batches, process-scheduled-individual, send-individual, and
// schedule-batch. Replaces the local copy in process-batches/index.ts.
//
// Behaviour:
//   1. Atomically claim the user row (UPDATE … WHERE status='token_expired').
//      If the claim is lost (another worker is already refreshing), return
//      { ok: false, reason: 'lock_lost' } so the caller can decide what to do.
//   2. POST to {authorityHost}/{tenantId}/oauth2/v2.0/token with
//      grant_type=refresh_token.
//   3. On success: persist new access_token, rotated refresh_token, expires_at,
//      status='active'. (Microsoft rotates the refresh token on every use — see
//      https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens.)
//   4. On invalid_grant: set status='token_expired', refresh_token=NULL.
//      Caller should return 403 token_expired to the user (re-auth required).
//   5. On any other failure: release the lock by setting status back to
//      'token_expired' so the next caller can retry.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"
import { getOAuthConfig } from "./getOAuthConfig.ts"

export type RefreshResult =
  | { ok: true; access_token: string; refresh_token: string; expires_at: string }
  | { ok: false; reason: "lock_lost" | "no_refresh_token" | "no_oauth_config" | "invalid_grant" | "network" | "unknown" }

const REFRESH_TIMEOUT_MS = 15_000

export async function tryRefreshToken(
  supabase: SupabaseClient,
  userId: string,
  currentRefreshToken: string | null
): Promise<RefreshResult> {
  // ─── Step 1: Atomic claim ──────────────────────────────────────────────
  // Only the worker that flips status from 'token_expired' to 'processing'
  // proceeds. Concurrent workers see no rows updated and bail with lock_lost.
  const now = new Date().toISOString()
  const { data: claimed, error: claimErr } = await supabase
    .from("user_ms_graph_links")
    .update({ status: "processing", processing_since: now })
    .eq("user_id", userId)
    .eq("status", "token_expired")
    .select("user_id")
    .maybeSingle()

  if (claimErr) {
    console.error(`[tryRefreshToken] claim DB error for user ${userId}:`, claimErr)
    return { ok: false, reason: "unknown" }
  }
  if (!claimed) {
    // Another worker is refreshing, or status already flipped to active
    return { ok: false, reason: "lock_lost" }
  }

  try {
    // ─── Step 2: Resolve credentials ────────────────────────────────────
    if (!currentRefreshToken) {
      await releaseLock(supabase, userId, "token_expired", false)
      return { ok: false, reason: "no_refresh_token" }
    }
    const oauthConfig = await getOAuthConfig(supabase, userId)
    if (!oauthConfig) {
      await releaseLock(supabase, userId, "token_expired", false)
      return { ok: false, reason: "no_oauth_config" }
    }

    // ─── Step 3: POST to Microsoft token endpoint ───────────────────────
    const tokenUrl = `${oauthConfig.authorityHost}/${oauthConfig.tenantId}/oauth2/v2.0/token`
    const body = new URLSearchParams({
      client_id: oauthConfig.clientId,
      client_secret: oauthConfig.clientSecret,
      grant_type: "refresh_token",
      refresh_token: currentRefreshToken,
      scope: "https://graph.microsoft.com/.default offline_access",
    })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS)
    let resp: Response
    try {
      resp = await fetch(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      await releaseLock(supabase, userId, "token_expired", false)
      console.error(`[tryRefreshToken] network error for user ${userId}:`, err)
      return { ok: false, reason: "network" }
    }
    clearTimeout(timeout)

    const tokens = await resp.json()

    // ─── Step 4: invalid_grant → re-auth required ──────────────────────
    if (!resp.ok && tokens.error === "invalid_grant") {
      // 90-day window elapsed OR user revoked consent OR admin revoked.
      // Null the refresh_token so the next /authorize is forced.
      await supabase
        .from("user_ms_graph_links")
        .update({ status: "token_expired", processing_since: null, refresh_token: null })
        .eq("user_id", userId)
      console.log(`[tryRefreshToken] invalid_grant for user ${userId} — re-auth required`)
      return { ok: false, reason: "invalid_grant" }
    }

    if (!resp.ok) {
      await releaseLock(supabase, userId, "token_expired", false)
      console.error(`[tryRefreshToken] token endpoint returned ${resp.status}:`, tokens)
      return { ok: false, reason: "unknown" }
    }

    // ─── Step 5: Persist new tokens ────────────────────────────────────
    // Microsoft rotates the refresh token on every successful exchange
    // (https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token).
    // If they did not return a new one, keep the existing one (defensive).
    const expiresInSec = tokens.expires_in || 3600
    const expiresAt = new Date(Date.now() + (expiresInSec - 300) * 1000).toISOString()
    const newRefreshToken = tokens.refresh_token || currentRefreshToken

    const { error: persistErr } = await supabase
      .from("user_ms_graph_links")
      .update({
        access_token: tokens.access_token,
        refresh_token: newRefreshToken,
        expires_at: expiresAt,
        status: "active",
        processing_since: null,
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)

    if (persistErr) {
      console.error(`[tryRefreshToken] persist error for user ${userId}:`, persistErr)
      // Token endpoint succeeded but DB write failed — return success with
      // the in-memory tokens so the caller's request isn't lost. The next
      // refresh attempt will see DB-side expires_at as stale and re-claim.
      return {
        ok: true,
        access_token: tokens.access_token,
        refresh_token: newRefreshToken,
        expires_at: expiresAt,
      }
    }

    console.log(`[tryRefreshToken] refreshed for user ${userId}, expires_at=${expiresAt}`)
    return {
      ok: true,
      access_token: tokens.access_token,
      refresh_token: newRefreshToken,
      expires_at: expiresAt,
    }
  } catch (err) {
    // Defensive — should not reach here but if it does, release the lock
    await releaseLock(supabase, userId, "token_expired", false)
    console.error(`[tryRefreshToken] unexpected error for user ${userId}:`, err)
    return { ok: false, reason: "unknown" }
  }
}

async function releaseLock(
  supabase: SupabaseClient,
  userId: string,
  status: "token_expired" | "active",
  nullRefresh: boolean
): Promise<void> {
  const update: Record<string, unknown> = { status, processing_since: null }
  if (nullRefresh) update.refresh_token = null
  const { error } = await supabase.from("user_ms_graph_links").update(update).eq("user_id", userId)
  if (error) {
    console.error(`[tryRefreshToken] releaseLock error for user ${userId}:`, error)
  }
}
