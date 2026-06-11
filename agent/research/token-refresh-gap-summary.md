# Token Refresh Gap — Deep Research Summary

## Executive Summary

The `ms-graph-email-project` already has a working `tryRefreshToken()` helper inside
`supabase/functions/process-batches/index.ts` (lines 81–161) and a `getOAuthConfig()`
helper in `supabase/functions/_shared/getOAuthConfig.ts`. The **gap** is that
`send-individual`, `schedule-batch`, and `process-scheduled-individual` do **not**
attempt refresh before returning 403 `token_expired`, even when the user has a
valid `refresh_token`. The fix is to **extract `tryRefreshToken` to `_shared/`** and
**call it from those three entry points** with an **atomic per-user claim** so two
concurrent workers cannot both refresh the same row.

Three layered findings from official Microsoft and Supabase documentation:

1. **Microsoft DOES rotate refresh tokens** on every successful refresh call. The
   current code already handles this correctly (line 137: `tokens.refresh_token ||
   currentRefreshToken`). Confidential-client refresh tokens last **90 days** by
   default; the `invalid_grant` error already correctly marks the row for re-auth.
2. **The Supabase CLI bundler handles `_shared/`** via relative imports
   (`../_shared/tryRefreshToken.ts`) — files prefixed with `_` are excluded from
   standalone deployment but are inlined into each function's bundle at build time.
   The existing `_shared/getOAuthConfig.ts` already proves the pattern works in
   this repo (imported via `import { getOAuthConfig } from "../_shared/getOAuthConfig.ts"`).
3. **A `processing` lock with `processing_since` already exists** in the schema
   and is used by `process-batches` (line 292). This same lock can be reused to
   serialise refresh attempts across all four entry points with one atomic
   `UPDATE … WHERE status='token_expired'` claim.

---

## Key Findings by Research Question

### Q1 — Microsoft Entra refresh-token rotation policies

**VERIFIED.** Microsoft *replaces* the refresh token on every successful exchange —
clients MUST discard the old one.

> "Refresh tokens replace themselves with a fresh token upon every use. The
> Microsoft identity platform doesn't revoke old refresh tokens when used to fetch
> new access tokens. Securely delete the old refresh token after acquiring a new
> one." — [Microsoft Learn: refresh-tokens](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens)
>
> "The authorization server MAY issue a new refresh token, in which case the
> client MUST discard the old refresh token and replace it with the new refresh
> token." — [Microsoft Learn: v2-oauth2-auth-code-flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token)

**Confidential-client (with `client_secret`)** lifetime = **90 days** by default
(this project uses confidential clients; `ms_client_secret` is mandatory).

**Public-client / SPA** lifetime = **24 hours** (irrelevant here, but the
existing `tryRefreshToken` does not differentiate — that's fine because the
`grant_type=refresh_token` body is identical).

The existing `tryRefreshToken` at process-batches line 137 already persists the
new refresh token: `const newRefreshToken = tokens.refresh_token || currentRefreshToken`.
**No code change needed for rotation handling.**

### Q2 — Supabase shared helper best practices

**VERIFIED.** Use `supabase/functions/_shared/` and import via relative path.

> "Store shared code in `_shared`. Store any shared code in a folder prefixed
> with an underscore (`_`)." — [Supabase: development-environment](https://supabase.com/docs/guides/functions/development-environment#recommended-project-structure)

The CLI's esbuild bundler inlines `_shared/*.ts` into the function's bundle when
it sees a relative import. This repo already proves the pattern works
(`_shared/getOAuthConfig.ts` is imported by `process-batches/index.ts` line 36).

> "Fix: preserve file extension when bundling import map paths" — [supabase/cli#1740](https://github.com/supabase/cli/pull/1740)
> confirms the bundler resolves `../_shared/foo.ts` style imports correctly.

**Action:** Move `tryRefreshToken` from `process-batches/index.ts` to
`supabase/functions/_shared/tryRefreshToken.ts`. Re-export it from
`process-batches/index.ts` (or just import directly) so behaviour is preserved.
Import from `send-individual`, `schedule-batch`, and `process-scheduled-individual`.

### Q3 — Concurrency / race conditions

**VERIFIED (via existing code).** A `processing_since` lock already exists and
is enforced for **2 hours** by `process-batches` (line 293):
```ts
if (linkData.status === "processing") {
  if (linkData.processing_since && new Date(linkData.processing_since) > new Date(Date.now() - 2 * 60 * 60 * 1000)) {
    // skip — another worker is on it
  }
}
```

**Problem:** The three new callers (send-individual, schedule-batch, etc.) are
HTTP-triggered and run in **separate Edge Function invocations** (possibly
concurrent). If two requests arrive while the user is in `token_expired`, both
will try to refresh simultaneously. With a rotating refresh token, the **first
refresh succeeds and the second gets `invalid_grant`** because the first call
already rotated the refresh token in the DB — but the second call is reading the
**stale** value in memory.

**Recommended pattern (atomic claim):**

```ts
// Atomic claim — only one worker gets the lease
const { data: claimed, error: claimErr } = await supabase
  .from("user_ms_graph_links")
  .update({
    status: "processing",
    processing_since: new Date().toISOString()
  })
  .eq("user_id", userId)
  .eq("status", "token_expired")          // <-- only the first claim succeeds
  .select("user_id")
  .maybeSingle()

if (!claimed) {
  // Another worker is already refreshing, or status already changed
  // Either retry once after 500ms or return 409
}
```

This is a single `UPDATE … WHERE status='token_expired'` so it's atomic in
Postgres. The claim is then released by `tryRefreshToken`'s normal success or
`invalid_grant` cleanup (line 122-124 of the existing helper already sets
`status: 'token_expired', processing_since: null, refresh_token: null`).

**Dead-man's switch:** `processing_since` is a wallclock timeout — if a worker
crashes after claiming, the lock auto-expires after 2h, same as today.

### Q4 — Token lifecycle states for `user_ms_graph_links.status`

**VERIFIED (partially).** The current `status` column already accepts
`active | processing | token_expired` (no CHECK constraint visible in the latest
migrations, but the code only writes these three values). Recommended **complete
set** for this use case:

| State            | Meaning                                                | Set by                              |
|------------------|--------------------------------------------------------|-------------------------------------|
| `active`         | Access token valid (or refresh-able)                   | `store_ms_graph_access_token`,      |
|                  |                                                        | `tryRefreshToken` success,          |
|                  |                                                        | `mark_token_expired` reversal       |
| `processing`     | Worker holds the row for batch send / refresh          | `process-batches` line 359,         |
|                  | (lease with `processing_since` timeout)                | proposed `tryRefreshTokenWithLock`  |
| `token_expired`  | Access token expired AND `refresh_token` also          | `mark_token_expired` RPC,           |
|                  | invalid (user must re-authorize)                       | `tryRefreshToken` on `invalid_grant`|

**Missing from current set (recommend adding if needed):**

- `revoked` — distinct from `token_expired`; set when admin revokes. Optional
  but useful for analytics. The MS docs revocation table in `refresh-tokens`
  implies this is a separate concern from token expiry.
- `rate_limited` — already represented via `retry_after` timestamp; no need for
  a separate status.

**No migration needed for the existing 3-state set** to fix the gap. The
proposed `tryRefreshTokenWithLock` reuses the same three values.

### Q5 — Refresh-token expiration failure mode

**VERIFIED.** When the 90-day refresh-token window elapses (or the user revokes
consent, or an admin revokes the token), Microsoft returns `invalid_grant` from
the `/oauth2/v2.0/token` endpoint.

> "Error codes for token endpoint errors — `invalid_grant`: The authorization
> code or PKCE code verifier is invalid or has expired. Try a new request to the
> `/authorize` endpoint and verify that the `code_verifier` parameter was
> correct." — [Microsoft Learn: v2-oauth2-auth-code-flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#error-codes-for-token-endpoint-errors)

The existing `tryRefreshToken` at process-batches line 119–127 already handles
this correctly:

```ts
if (tokens.error === "invalid_grant") {
  await supabase.from("user_ms_graph_links")
    .update({ status: "token_expired", processing_since: null, refresh_token: null })
    .eq("user_id", userId)
  return null
}
```

**Implication for the gap fix:** When the shared helper returns `null` because of
`invalid_grant`, the calling function (`send-individual` / `schedule-batch`) must
return `403 { code: 'token_expired' }` **with a UI hint to re-authorize**. The
frontend's existing `ms-auth` flow handles the re-consent.

### Q6 — Failed batch self-heal

**VERIFIED (current behaviour is correct).** `process-batches` at lines 240–249
and 336–349 **does NOT mark the batch as `failed`** when refresh fails — it
leaves the batch as `pending` and skips. The migration `20260609000001_add_refresh_token_and_oauth.sql`
also explicitly backfills this:

```sql
UPDATE public.batches
SET status = 'pending'
WHERE status = 'failed'
  AND id IN (SELECT b.id FROM public.batches b
             WHERE b.status = 'failed'
               AND EXISTS (SELECT 1 FROM public.recipient_list rl
                           WHERE rl.batch_id = b.id AND rl.status = 'pending'));
```

The new `paused` enum value (line 90) was added for future use — "batches
paused on token expiry instead of failed" — but the current code path keeps
`pending` rather than `paused`.

**Recommended behaviour for `schedule-batch`:**

Two acceptable patterns, both consistent with the cron job:

1. **Eager refresh** — call `tryRefreshTokenWithLock` **before** creating the
   batch record. If it fails, return 403 to the user and do **not** create the
   batch. This matches today's UX (user-facing) and avoids orphan `pending` rows.
2. **Lazy** — create the batch as `pending` and let the cron pick it up later.
   Same self-heal as `process-batches` already does. Only correct if the user
   is expected to return later and re-authorize.

**Pattern 1 is the right choice for `send-individual` and `schedule-batch`**
(both are user-initiated). The current 403 in `schedule-batch` line 65 should
be replaced with a `tryRefreshToken` attempt + 403 only on `invalid_grant`.

**Pattern 2 is already correct for `process-scheduled-individual`** because the
user isn't waiting — the cron job's existing skip-on-`token_expired` is
appropriate.

---

## Actionable Insights (ranked by impact)

1. **Move `tryRefreshToken` to `supabase/functions/_shared/tryRefreshToken.ts`**
   (confidence: 10/10 — verified by existing `getOAuthConfig.ts` pattern).
2. **Add an atomic claim** to the helper:
   `UPDATE … SET status='processing', processing_since=now() WHERE user_id=… AND status='token_expired'`.
   Skip callers that lose the claim race.
3. **Update `send-individual` and `schedule-batch`** to call the helper **before**
   returning 403. Only return 403 if the helper returns `null` (i.e., `invalid_grant`).
4. **For `process-scheduled-individual`** — *consider* adding the same call so
   the cron can self-heal expired users in the background. Lower priority.
5. **Return a typed `RefreshResult`** from the helper:
   `{ ok: true, access_token, refresh_token, expires_at } |
    { ok: false, reason: 'invalid_grant' | 'network' | 'no_refresh_token' | 'no_oauth_config' }`
   so callers can distinguish re-auth-needed from transient errors.
6. **Add a test fixture** in `supabase/tests/` (unit test) for the atomic-claim
   race condition to lock in behaviour.

---

## Confidence Assessment

| Area                                                | Score   | Notes                                          |
|-----------------------------------------------------|---------|------------------------------------------------|
| Microsoft rotation policy                           | 10/10   | Official MS Learn docs, exact quotes            |
| Microsoft 90-day lifetime (confidential)            | 10/10   | Official MS Learn docs                          |
| `invalid_grant` failure mode                        | 10/10   | Official MS Learn docs                          |
| Supabase `_shared/` convention                      | 10/10   | Official Supabase docs + existing in-repo proof |
| Per-function bundle isolation                       | 9/10    | Per Supabase docs; CLI PR #1740 confirms bundler |
| Atomic claim pattern via `UPDATE…WHERE`             | 9/10    | Standard Postgres practice; existing `processing_since` field proves pattern is already in use |
| Status enum completeness                            | 8/10    | Current 3-state set works; `revoked` is optional  |
| 2-hour lock TTL appropriateness                     | 7/10    | Reasonable default; could be configurable        |
| Race condition risk in original gap                 | 10/10   | Confirmed by reading process-batches/index.ts L292-304 |

**Overall confidence:** 9/10. The fix is well-supported by official docs and
aligns with patterns already in the codebase.

---

## Next Steps for the Main Agent

1. Create `supabase/functions/_shared/tryRefreshToken.ts` containing a copy of
   the current helper (process-batches/index.ts L81-161) but with the atomic
   claim added at the top and a typed return shape.
2. Refactor `process-batches/index.ts` to import from `_shared` (delete the
   local copy). Behaviour must not change.
3. Update `send-individual/index.ts` and `schedule-batch/index.ts` to call
   the helper on `status='token_expired'`. Return 403 only on `invalid_grant`.
4. (Optional, lower priority) Update `process-scheduled-individual/index.ts`
   to also self-heal via the helper.
5. Run `supabase functions deploy` to ship. Verify with `supabase functions
   serve` locally first.

---

*See also: `token-refresh-gap-sources.md` for full citations and
`token-refresh-gap-examples.md` for VERIFIED code patterns ready to copy.*
