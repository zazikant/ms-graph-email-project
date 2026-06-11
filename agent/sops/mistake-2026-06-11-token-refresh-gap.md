# Mistake Log: Misleading "Auto-Refresh Active" UI + Incomplete Token Refresh in Edge Functions

## Date: 2026-06-11

## Severity: High (blocks the entire product for the user)

## Context
A user with a valid Microsoft Graph `refresh_token` and per-user Azure AD credentials could not send emails via the Compose tab. Settings UI claimed auto-refresh would fix it, but it didn't.

## What Happened

### Symptom 1 (Compose tab)
User `business@gem-engserv.net` (different Entra ID — `3780d0ca-6921-4bcd-83a9-b8a47bf74088`) tries to send a test email via Compose → "Send to List" → "test" list. Gets:

```
Error: Your Microsoft Graph token has expired. Please update it in Settings.
```

### Symptom 2 (Settings tab)
Same user, same DB state, sees:

> **Status: Token expired - will auto-refresh on next batch run**
>
> **A** Sign in with Microsoft (Recommended)
> ...
> Auto-refresh is active — tokens will be refreshed automatically.

The two messages contradicted each other AND the auto-refresh promise was a lie for the Compose path.

### Network trace
`POST /functions/v1/schedule-batch` returned:

```json
{"error":"Microsoft Graph token has expired. Please update your access token in Settings.","code":"token_expired"}
```

HTTP **403**. The frontend (App.tsx L595) transforms this into the user-facing message.

## Root Cause

`send-individual/index.ts` (L47–68) and `schedule-batch/index.ts` (L58–68) read `user_ms_graph_links.status` and, if it is `'token_expired'`, **immediately returned 403 without attempting a refresh**. The only place in the codebase that did refresh was the inlined `tryRefreshToken` helper inside `process-batches/index.ts` (L81–161), used only by the pg_cron `*/5 * * * *` path.

The Settings UI message was written assuming all paths refresh, but only the cron path did.

## The Fix

(Implemented per `agent/task/Token_Auto_Refresh_Fix_PRD.md`)

1. Extracted `tryRefreshToken` to `supabase/functions/_shared/tryRefreshToken.ts` (matches existing `_shared/getOAuthConfig.ts` convention; CLI esbuild inlines the import).
2. Added an **atomic claim** at the top of the helper to prevent rotating-refresh-token races when two edge function invocations try to refresh simultaneously.
3. Wired the helper into `send-individual` and `schedule-batch` so they refresh before returning 403.
4. Added `RefreshResult` discriminated union for typed error handling (`lock_lost`→409, `invalid_grant`→403, `network`→500, etc.).
5. Updated `App.tsx` SettingsTab `statusText()` (L2750–2766) to replace the misleading "next batch run" message with "on next send".

## Lessons Learned

1. **UI promises must be backed by code paths.** The "Auto-refresh is active" line was true only for ONE of THREE refresh-capable entry points. UI text should either (a) be true for all relevant paths, or (b) be scoped to the specific path that delivers on it.
2. **Sharing helpers via `_shared/` is the right Supabase pattern.** The duplicate inlined `tryRefreshToken` in `process-batches` AND `detect-bounces` (twice) was a maintenance hazard. The same bug had to be fixed in three places; a single helper now lives in one place.
3. **Atomic claim is mandatory when refresh tokens rotate.** Microsoft rotates the refresh token on every successful exchange. Two concurrent refreshers will cause the second to fail with `invalid_grant` because the first already rotated the token out from under it. The `UPDATE … WHERE status='token_expired'` claim is the standard Postgres way to make this safe.
4. **The `processing_since` lock is reusable.** It was already in the schema and used for batch send contention; the same field now serializes refresh attempts. No new column needed.

## Prevention Checklist

- [ ] When adding a new edge function that touches `user_ms_graph_links`, check if it needs to call `tryRefreshToken` (imported from `_shared/`).
- [ ] When adding UI copy that promises a backend behavior, verify the promise holds across ALL code paths that backend can be reached from.
- [ ] When designing typed return values for an async helper, prefer discriminated unions over `null | {…}` so callers can't accidentally treat errors as success.
- [ ] Always read `refresh_token` from `user_ms_graph_links` BEFORE the `tryRefreshToken` call (the helper claims the row and the caller's in-memory copy may be stale).

## Related

- PRD: `agent/task/Token_Auto_Refresh_Fix_PRD.md`
- Research: `agent/research/token-refresh-gap-summary.md`, `…-sources.md`, `…-examples.md`
- Deep-think KG: 23 nodes, 21 edges, validation score 0.78
- Existing SOP (directly applicable): `agent/sops/supabase-insert-silent-failure.md` — every Supabase write in the new helper checks `error` and logs via `console.error()`.

## Status: FIXED (pending deployment)
