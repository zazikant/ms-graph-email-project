# PRD: Auto-Refresh Microsoft Graph Tokens in send-individual and schedule-batch

## Context

User `business@gem-engserv.net` reported that emails sent via the Compose tab to the "test" recipient list fail with **HTTP 403 `code: "token_expired"`**, even though their `user_ms_graph_links.refresh_token` is valid. The Settings UI further compounds the problem by displaying two contradictory messages: *"Token expired - will auto-refresh on next batch run"* and *"Auto-refresh is active — tokens will be refreshed automatically."* — the first is true for cron-driven paths, the second is false for the user-initiated Compose path.

Root cause: the **only** place in the codebase that refreshes a Microsoft Graph access token is the inlined `tryRefreshToken` helper inside `supabase/functions/process-batches/index.ts` (L81–161). The two **user-initiated** entry points — `send-individual` (used by Compose) and `schedule-batch` (used by "Send to List") — read `user_ms_graph_links.status` and, if it is `'token_expired'`, immediately return 403 without ever attempting a refresh. The cron path `process-scheduled-individual` is intentionally left as-is because it already self-heals via migration `20260609000001_add_refresh_token_and_oauth.sql` and its own user-initiated refresh would just race with the hourly backfill.

Research artifact `agent/research/token-refresh-gap-summary.md` (deep-research, confidence 9/10) recommends: **(1)** extract `tryRefreshToken` into a shared helper at `supabase/functions/_shared/tryRefreshToken.ts` (matching the existing `_shared/getOAuthConfig.ts` convention), **(2)** add an **atomic per-user claim** (`UPDATE … SET status='processing', processing_since=now() WHERE user_id=? AND status='token_expired'`) so two concurrent invocations cannot both POST to the token endpoint and trigger a rotating-refresh-token race, and **(3)** wire the helper into `send-individual` and `schedule-batch` with a typed `RefreshResult` discriminated union that maps cleanly to HTTP responses (`invalid_grant`→403, `lock_lost`→409, `network`→500).

The UI copy in `src/App.tsx` SettingsTab `statusText()` (L2750–2766) must also be updated to reflect the new behaviour: when `status === 'token_expired'`, the message should direct the user to **manually re-authorize in Settings** (because the helper will have already attempted a refresh on the next send attempt), and the misleading "auto-refresh is active" line must be removed.

## Requirements

- [ ] `supabase/functions/_shared/tryRefreshToken.ts` exists and is the single source of truth for refresh logic.
- [ ] `tryRefreshToken` performs an **atomic claim** at the top: `UPDATE user_ms_graph_links SET status='processing', processing_since=now() WHERE user_id=? AND status='token_expired' RETURNING user_id`. If zero rows are returned, the helper returns `{ ok: false, reason: 'lock_lost' }`.
- [ ] `tryRefreshToken` returns a discriminated `RefreshResult` union: `{ ok: true, access_token, refresh_token, expires_at } | { ok: false, reason: 'lock_lost' | 'no_refresh_token' | 'no_oauth_config' | 'invalid_grant' | 'network' | 'unknown' }`.
- [ ] `process-batches/index.ts` is refactored to **import** from `../_shared/tryRefreshToken.ts`; the local inlined copy is removed. No behaviour change.
- [ ] `send-individual/index.ts` calls `tryRefreshToken` **before** returning 403 when `status='token_expired'`. Only returns 403 if the helper returns `{ ok: false, reason: 'invalid_grant' | 'no_refresh_token' | 'no_oauth_config' | 'unknown' }`. Returns **409 `code: 'refresh_in_progress'`** when `reason: 'lock_lost'`. Falls through to the normal send path on success.
- [ ] `schedule-batch/index.ts` calls `tryRefreshToken` **before** the `INSERT INTO batches` when `status='token_expired'`. On failure, **does not** create an orphan `pending` batch; returns 403 / 409 as above.
- [ ] `detect-bounces/index.ts` continues to use its inlined helper; optional cleanup to use the shared helper is in scope (low priority, see Phase 5).
- [ ] `src/App.tsx` SettingsTab `statusText()` (L2750–2766) copy is updated: when `status === 'token_expired'`, show a clear "Please re-authorize Microsoft Graph in Settings" message. The "Auto-refresh is active — tokens will be refreshed automatically" string is **removed**.
- [ ] All four functions still work when the Supabase CLI bundles `_shared/` (verified by existing `_shared/getOAuthConfig.ts` import pattern in `process-batches/index.ts` L36).
- [ ] No new database migration. Uses existing `status`, `processing_since`, `refresh_token`, `expires_at`, `updated_at` columns.
- [ ] All database UPDATE writes from the new helper include explicit `console.error()` on `error` (per SOP `supabase-insert-silent-failure.md`).

## Scope

### In Scope

- New file: `supabase/functions/_shared/tryRefreshToken.ts` (extracted from `process-batches/index.ts` L81–161, with atomic claim added).
- Modified file: `supabase/functions/process-batches/index.ts` (refactor — delete local copy, import from `_shared/`).
- Modified file: `supabase/functions/send-individual/index.ts` (add refresh-on-token-expired branch, ~25 lines).
- Modified file: `supabase/functions/schedule-batch/index.ts` (add refresh-on-token-expired branch, ~25 lines).
- Modified file: `supabase/functions/detect-bounces/index.ts` (optional cleanup, replace inlined helper with `_shared/` import — Phase 5).
- Modified file: `src/App.tsx` SettingsTab `statusText()` (L2750–2766) — update misleading copy.
- Smoke test in Chrome (Compose → test list → send).
- Verification of DB state and edge function logs.

### Out of Scope

- Modifying `process-scheduled-individual/index.ts` (intentionally left as-is per Q6 of the research — cron self-heal already works via migration `20260609000001`).
- Adding a new `status` enum value (e.g. `revoked`) — current 3-state set is sufficient.
- Modifying the 2-hour `processing_since` lock TTL (deemed appropriate; could be a follow-up).
- Frontend retry/backoff for 409 `refresh_in_progress` responses (server returns the code; client can add UX later).
- OAuth scope changes — still uses `https://graph.microsoft.com/.default offline_access`.
- Token vault migration — still uses plaintext `access_token` and `refresh_token` columns.
- A formal unit-test harness (research example #7 is illustrative; full Deno test infra not in scope).

## Technical Design

### Key Components

- **`supabase/functions/_shared/tryRefreshToken.ts`** (NEW) — Single source of truth. ~180 lines. Performs atomic claim → resolves OAuth config via `getOAuthConfig` → POSTs to `/{tenantId}/oauth2/v2.0/token` with `grant_type=refresh_token` → persists rotated tokens → returns `RefreshResult`. Releases the lock on every error path.
- **`supabase/functions/_shared/getOAuthConfig.ts`** (EXISTING) — 3-tier OAuth lookup (user-level → tenant-level → global). Reused unchanged.
- **`process-batches/index.ts`** (MODIFIED) — Replace L81–161 with `import { tryRefreshToken } from "../_shared/tryRefreshToken.ts"`. No call-site changes needed (it currently calls the local function with the same signature).
- **`send-individual/index.ts`** (MODIFIED) — After auth/JWT check, replace the bare `if (linkData.status === "token_expired") return 403` branch with a call to `tryRefreshToken` followed by a switch on `result.reason`.
- **`schedule-batch/index.ts`** (MODIFIED) — Same pattern as `send-individual`, inserted **before** the `INSERT INTO batches` call so a failed refresh does not create an orphan row.
- **`detect-bounces/index.ts`** (OPTIONAL, Phase 5) — Replace inlined helper with shared import. Pure refactor, no behaviour change.
- **`src/App.tsx` SettingsTab `statusText()`** (MODIFIED) — Rewrite the `status === 'token_expired'` branch and remove the "Auto-refresh is active" line.

### Dependencies

**Existing files modified:**
- `supabase/functions/process-batches/index.ts`
- `supabase/functions/send-individual/index.ts`
- `supabase/functions/schedule-batch/index.ts`
- `supabase/functions/detect-bounces/index.ts` (optional)
- `src/App.tsx`

**Existing files read (no change):**
- `supabase/functions/_shared/getOAuthConfig.ts`
- Migration `20260609000001_add_refresh_token_and_oauth.sql` (the cron backfill this fix complements)
- `supabase/migrations/*` (column existence confirmed via `agent/system/Database_Tables.md`)

**New files created:**
- `supabase/functions/_shared/tryRefreshToken.ts`

**No new npm / esm dependencies.** Uses `https://esm.sh/@supabase/supabase-js@2.39.0` (already in use by `getOAuthConfig.ts`).

### API/Interface Changes

```typescript
// supabase/functions/_shared/tryRefreshToken.ts — NEW PUBLIC API

export type RefreshResult =
  | { ok: true;  access_token: string; refresh_token: string; expires_at: string }
  | { ok: false; reason: "lock_lost" | "no_refresh_token" | "no_oauth_config"
                 | "invalid_grant" | "network" | "unknown" }

export async function tryRefreshToken(
  supabase: SupabaseClient,
  userId: string,
  currentRefreshToken: string | null,
): Promise<RefreshResult>

// Internal — not exported:
async function releaseLock(
  supabase: SupabaseClient,
  userId: string,
  status: "token_expired" | "active",
  nullRefresh: boolean,
): Promise<void>
```

```typescript
// HTTP RESPONSE CONTRACT — new mapping in send-individual / schedule-batch
//
// | RefreshResult.reason       | HTTP | code                  | UI action              |
// |----------------------------|------|-----------------------|------------------------|
// | ok: true                   | 200  | (fall through send)   | —                      |
// | lock_lost                  | 409  | refresh_in_progress   | retry after 500ms      |
// | invalid_grant              | 403  | token_expired         | re-authorize in Settings|
// | no_refresh_token           | 403  | token_expired         | re-authorize in Settings|
// | no_oauth_config            | 403  | token_expired         | re-authorize in Settings|
// | network                    | 500  | refresh_network_error | retry after 5s         |
// | unknown                    | 500  | token_expired         | re-authorize in Settings|
```

```typescript
// src/App.tsx — SettingsTab statusText() NEW COPY
//
// status === 'active'         → "Connected to Microsoft Graph"
// status === 'processing'     → "Refreshing token — please wait"
// status === 'token_expired'  → "Microsoft Graph authorization expired. Please re-authorize in Settings."
//
// REMOVED: the line "Auto-refresh is active — tokens will be refreshed automatically."
//   (It was only true for the cron path; user-initiated sends now also refresh, but
//   the user should be told to re-authorize if status is still token_expired after
//   the helper's attempt — i.e., invalid_grant.)
```

## Implementation Plan

### Phase 1: Extract shared helper

- [ ] Create `supabase/functions/_shared/tryRefreshToken.ts` by copying the body of `process-batches/index.ts` L81–161.
- [ ] Wrap the function signature in the new `RefreshResult` discriminated union from the technical design.
- [ ] Add the **atomic claim** block at the top (lines 62–78 of `agent/research/token-refresh-gap-examples.md` Example #1).
- [ ] Add the internal `releaseLock()` helper for non-invalid-grant error paths.
- [ ] Add `console.error()` on every `error` returned by the Supabase client (per SOP `supabase-insert-silent-failure.md`).
- [ ] Verify imports resolve: `SupabaseClient` from `https://esm.sh/@supabase/supabase-js@2.39.0`, `getOAuthConfig` from `./getOAuthConfig.ts`.

### Phase 2: Wire into process-batches (regression-test first)

- [ ] In `process-batches/index.ts`, add `import { tryRefreshToken } from "../_shared/tryRefreshToken.ts";` near the existing `getOAuthConfig` import (L36).
- [ ] Delete the local `tryRefreshToken` function body (L81–161) and any now-unused internal helpers it owned.
- [ ] Update the call site to handle the new return shape (existing call site likely assumes the old `null | {...}` return — adjust to check `result.ok`).
- [ ] Run `supabase functions serve process-batches` locally and trigger via `curl` with a known token-expired user; verify behaviour is identical to pre-refactor.

### Phase 3: Wire into send-individual

- [ ] Import `tryRefreshToken` from `../_shared/tryRefreshToken.ts`.
- [ ] Locate the existing `if (linkData.status === "token_expired") return 403` branch (referenced as L47–L68 in research).
- [ ] Replace it with the call-site pattern from `agent/research/token-refresh-gap-examples.md` Example #2 — including the `lock_lost` → 409 and `invalid_grant` → 403 mappings.
- [ ] On `ok: true`, fall through to the normal `select access_token` + `POST /me/sendMail` path. The just-persisted new token is now in the DB and will be picked up by the subsequent select.
- [ ] Add `console.error()` on any DB error.

### Phase 4: Wire into schedule-batch

- [ ] Import `tryRefreshToken` from `../_shared/tryRefreshToken.ts`.
- [ ] Locate the existing `if (linkData.status === "token_expired")` branch (referenced as L62–L68 in research).
- [ ] Replace it with the call-site pattern from `agent/research/token-refresh-gap-examples.md` Example #3 — refresh **before** the `INSERT INTO batches` so a failed refresh does not create an orphan `pending` row.
- [ ] Add `console.error()` on any DB error.

### Phase 5: (Optional) Clean up detect-bounces

- [ ] Replace the inlined helper at L61–121 with the shared import.
- [ ] Verify no call-site signature changes are needed.
- [ ] Deploy and confirm bounce detection still works (manual test with a known-bounced address).

### Phase 6: Update frontend copy

- [ ] Open `src/App.tsx` and find the SettingsTab `statusText()` function at L2750–2766.
- [ ] Replace the `status === 'token_expired'` branch with the new copy (see API/Interface Changes above).
- [ ] Remove the "Auto-refresh is active — tokens will be refreshed automatically." string.
- [ ] Save; verify in Chrome dev tools that the new copy renders.

### Phase 7: Test & verify

- [ ] **Chrome manual test (the original repro):** Log in as `business@gem-engserv.net`, go to Compose tab, select the "test" recipient list, click Send. Expect 200 (not 403) and the email to land in the test inbox.
- [ ] **DB state verification:** Run `SELECT user_id, status, expires_at, processing_since FROM user_ms_graph_links WHERE user_id = '<business user id>';`. Expect `status = 'active'`, `processing_since IS NULL`, and `expires_at` to be a fresh timestamp (~55 min in the future).
- [ ] **Edge function logs:** Check `supabase functions logs send-individual` and `supabase functions logs schedule-batch`. Expect a `[tryRefreshToken] refreshed for user …` log line on the first send after this fix ships.
- [ ] **process-batches regression test:** Trigger `process-batches` via the cron (or `supabase functions invoke process-batches`). Expect normal processing with no errors.
- [ ] **Concurrent send race test:** Open two browser tabs as the same user, click Send in both within ~1 second. Expect one to return 200, the other to return 409 `refresh_in_progress`. Verify DB state is consistent (`status='active'`, single token rotation).
- [ ] **invalid_grant test:** Manually set `user_ms_graph_links.refresh_token = 'garbage'` for a test user, send an email. Expect 403 `code: 'token_expired'`, `reason: 'invalid_grant'`, and the DB row to flip to `refresh_token = NULL, status = 'token_expired'`.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Two concurrent refreshes race and second one gets `invalid_grant` | High (regression) | Atomic claim via `UPDATE … WHERE status='token_expired'` — only first worker proceeds; others get `lock_lost` → 409 |
| `_shared/` import not bundled into send-individual / schedule-batch (no import map) | Low | Verified by existing `_shared/getOAuthConfig.ts` import at `process-batches/index.ts:36`; Supabase CLI esbuild inlines relative `_shared/` imports at deploy time |
| Helper drops error on the floor (Supabase silent-failure SOP) | Medium | Add explicit `console.error()` on every `{ error }` from `.update()` / `.from()` calls (per `agent/sops/supabase-insert-silent-failure.md`) |
| Refresh succeeds but caller still uses stale `linkData` object in memory | Medium | After `ok: true`, caller re-reads from DB (or uses `result.access_token` directly); never trusts the pre-refresh in-memory copy |
| `schedule-batch` creates orphan `pending` batch on refresh failure | Medium | Refresh is inserted **before** the `INSERT INTO batches`; failed refresh → 403 returned, no row created |
| Frontend still shows old "auto-refresh is active" copy, misleads user | Low | Phase 6 explicitly rewrites the SettingsTab `statusText()` copy; verified in Chrome |
| Microsoft rotates refresh token but our DB write fails | Low | Helper already persists `tokens.refresh_token || currentRefreshToken`; if the UPDATE errors, `releaseLock` still runs and the next caller retries (worst case: user re-authorizes, but no data corruption) |
| 15s `REFRESH_TIMEOUT_MS` aborts mid-POST, leaves user in `processing` | Low | `releaseLock` runs in the `try/catch` and on the network-error branch, so lock is always released on the failure path |
| `processing_since` lock not released if worker crashes | Low | Existing `reset-stuck-processing-locks` cron (`*/30 * * * *`) already force-resets locks older than 2 hours |
| New `RefreshResult` shape breaks an existing call site that assumed the old `null | {...}` return | Medium | Phase 2 (process-batches refactor) is the regression test — must pass before Phase 3/4 ship |

## Success Criteria

- [ ] `business@gem-engserv.net` can send a Compose email to the "test" list and receives **HTTP 200** (not 403) on the first attempt after this fix ships.
- [ ] `user_ms_graph_links` for the test user: `status` flips to `'active'`, `expires_at` is a fresh timestamp (~55 min ahead), `processing_since` is NULL, `refresh_token` is the newly rotated value.
- [ ] `process-batches` still picks up pending batches and processes them (regression test passes).
- [ ] Two concurrent sends from the same user: one succeeds, one returns 409 `refresh_in_progress`. DB ends in a consistent `active` state with exactly one token rotation.
- [ ] `invalid_grant` scenario: user with garbage `refresh_token` gets 403 `code: 'token_expired'` with `reason: 'invalid_grant'`; DB row is updated to `refresh_token = NULL, status = 'token_expired'`.
- [ ] Settings UI no longer displays the misleading "Auto-refresh is active — tokens will be refreshed automatically." string.
- [ ] No new database migration was applied; uses existing columns.
- [ ] All new code follows the silent-failure SOP: every `.update()` and `.insert()` call has an `if (error) console.error(...)` guard.

## Related Documents

- **Research (this fix):** `agent/research/token-refresh-gap-summary.md` (confidence 9/10), `agent/research/token-refresh-gap-sources.md`, `agent/research/token-refresh-gap-examples.md` (7 verified code patterns)
- **Research (prior):** `agent/research/microsoft-graph-auth-supabase-*.md` (OAuth fundamentals)
- **System:** `agent/system/Edge_Functions.md`, `agent/system/Database_Tables.md` (auth model), `agent/system/Cron_Reference.md`, `agent/system/Batch_Processing.md` (sequence diagram), `agent/system/Single_Processing.md` (send-individual sequence diagram)
- **Existing PRDs:** `agent/task/Batch_Processing_PRD.md`, `agent/task/Individual_Processing_PRD.md` — this PRD is a focused follow-up that does **not** supersede either.
- **SOP:** `agent/sops/supabase-insert-silent-failure.md` — applies directly: every Supabase write in the new helper must check `error` and log.
- **Reference function (the inlined helper being extracted):** `supabase/functions/process-batches/index.ts` L81–161
- **Reference function (the existing shared-helper pattern to mirror):** `supabase/functions/_shared/getOAuthConfig.ts` (already imported successfully by `process-batches/index.ts` L36)
- **Frontend location to update:** `src/App.tsx` SettingsTab `statusText()` L2750–2766
- **Migration this fix complements:** `supabase/migrations/20260609000001_add_refresh_token_and_oauth.sql` (the cron backfill that already self-heals `process-scheduled-individual`)
