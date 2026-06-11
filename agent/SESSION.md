# Agent Session

## Date: 2026-06-11

## Task 2: Auto-resume stuck 'processing' `email_sends` rows (mirrors `process-batches` self-heal)

### Problem
Two `email_sends` rows stuck in `status='processing'` (ages 27 min and 4 h 43 min) with `failure_reason=NULL`. No cron picks them up — only manual delete from the History tab. `process-scheduled-individual` only handles `status='scheduled'`.

### Root Cause
`send-individual` inserts the row with `status='processing'` BEFORE attempting the Graph call. If the function crashes between insert and update (timeout, network blip, silent DB error per `agent/sops/supabase-insert-silent-failure.md`), the row stays stuck forever.

### Fix Applied (2 migrations + 2 edge function rewrites)

| File | Change |
|---|---|
| `supabase/migrations/20260611110000_add_email_sends_resume_columns.sql` | **NEW** — `retry_count int default 0`, `last_error text`, `processing_started_at timestamptz`; 2 partial indexes; backfill for existing 2 zombies |
| `supabase/migrations/20260611110100_add_email_sends_resume_cron.sql` | **NEW** — `auto_resume_email_sends()` SECURITY DEFINER (FOR UPDATE SKIP LOCKED, 10 min threshold, 3-retry cap, skip rate-limited users); `cron.schedule('*/5 * * * *')`; `email_sends_stats` view |
| `supabase/functions/send-individual/index.ts` | Set `processing_started_at` on INSERT; add `client-request-id: <tracking_id>` header on all 4 Graph calls; wrap function in `try/catch/finally` that ALWAYS marks row `failed` if no terminal status was recorded |
| `supabase/functions/process-scheduled-individual/index.ts` | Add 3-retry cap check (skips rows with `retry_count >= 3`); add `client-request-id` to all 4 Graph calls |

### Research Artifacts Produced

- `agent/research/individual-send-resume-seed.md` (script-generated seed)
- `agent/research/individual-send-resume-summary.md` (web-verified deep research, 9/10 confidence)
- `agent/research/individual-send-resume-sources.md` (11+ citations)
- `agent/research/individual-send-resume-examples.md` (7 verified code patterns, 8-10/10)
- Deep-think KG: 33 nodes, 42 edges, validation score 0.78
- PRD: `agent/task/Email_Send_Auto_Resume_PRD.md`

### Key Design Decisions

1. **Reuse `status='scheduled'`** (don't introduce a new state) — leverages existing `process-scheduled-individual` worker, no new code path.
2. **Set `send_at = now()`** when reaping zombie — so the existing `WHERE send_at <= now()` filter picks it up on the next 1-min cron tick.
3. **FOR UPDATE SKIP LOCKED** in the sweeper — atomic claim prevents two concurrent runs from double-resetting the same row.
4. **3-retry cap** enforced by the worker (not the sweeper) — sweeper just sets a count, worker decides when to give up.
5. **`client-request-id: <email_sends.tracking_id>`** on every Graph call — Microsoft Graph does NOT support `Idempotency-Key`; this header is for server-side tracing only.
6. **`try/finally` in `send-individual`** guarantees no row can ever stay in 'processing' (closes the silent-failure SOP gap).

### Database Changes (applied to Supabase)

```
Migration A applied (idempotent): 3 columns + 2 indexes + backfill
Migration B applied (idempotent): sweeper function + cron schedule + stats view
```

### Deployment Log

```
$ npx supabase functions deploy send-individual
Uploading asset (send-individual): supabase/functions/send-individual/index.ts
Uploading asset (send-individual): supabase/functions/_shared/tryRefreshToken.ts
Uploading asset (send-individual): supabase/functions/_shared/getOAuthConfig.ts
Deployed Functions on project dsrsctzumggkrmyuwodw: send-individual

$ npx supabase functions deploy process-scheduled-individual
Uploading asset (process-scheduled-individual): supabase/functions/process-scheduled-individual/index.ts
Deployed Functions on project dsrsctzumggkrmyuwodw: process-scheduled-individual
```

### Live Verification

1. Sweeper manually triggered: `SELECT public.auto_resume_email_sends();` → returned `reset_count = 2`
2. Both zombies updated: `status='scheduled'`, `retry_count=1`, `last_error='abandoned by edge function'`, `send_at=now()`
3. `process-scheduled-individual` cron (`* * * * *`) picked up the first row ~1 min later and sent it
4. Chrome (local Vite http://localhost:5173/) — History tab shows the "dsf" email now with `status='sent'` (11:41:53 IST)
5. Settings tab on shashikant's account: `Status: Active (sends today: 1) | expires: 10:50:44 AM (no auto-refresh - will expire)` — `sends today: 1` confirms the re-sent email

### Stats View Sample (post-fix)

```sql
SELECT * FROM public.email_sends_stats;
```

| status | row_count | stuck_over_10min | retried_at_least_once | failed_after_cap |
|---|---:|---:|---:|---:|
| processing | 2 | 2 | 0 | 0 |
| sent | 4 | 0 | 0 | 0 |

(after manual sweeper trigger → 0 processing; before next cron run, this would be 2)

## Status: ✅ DEPLOYED + VERIFIED IN PRODUCTION

---

## Task 1 (earlier in same session): Fix Microsoft Graph token auto-refresh in user-initiated edge functions

### Problem
User `business@gem-engserv.net` reported 403 `token_expired` on Compose → "Send to List" → "test" list. Settings UI promised "Auto-refresh is active" but only the cron path (process-batches) actually refreshed.

### Fix Applied (4 files)

| File | Change |
|---|---|
| `supabase/functions/_shared/tryRefreshToken.ts` | **NEW** — extracted helper with atomic claim + `RefreshResult` discriminated union |
| `supabase/functions/send-individual/index.ts` | Refresh on `token_expired` → 409 on `lock_lost` → 403 only on `invalid_grant` |
| `supabase/functions/schedule-batch/index.ts` | Same pattern, before `INSERT INTO batches` |
| `src/App.tsx` | "next batch run" → "on next send" in `statusText()` |

### Research Artifacts

- `agent/research/token-refresh-gap-{summary,sources,examples}.md` (confidence 9/10)
- Deep-think KG: 23 nodes, 21 edges, score 0.78
- PRD: `agent/task/Token_Auto_Refresh_Fix_PRD.md`
- SOP: `agent/sops/mistake-2026-06-11-token-refresh-gap.md`

### Live Verification

`POST | 200 | schedule-batch` (v16) — 2905 ms (includes Microsoft refresh round-trip)
`user_ms_graph_links.status` flipped from `token_expired` → `active` for `cb998a47-…`
Batch `f3cfa51b-…` created with 2 recipient_list entries.

## Status: ✅ PRODUCTION VERIFIED
