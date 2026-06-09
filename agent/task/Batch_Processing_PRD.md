# PRD: Microsoft Graph Email Batch Scheduler

## 1. PROBLEM STATEMENT

Build a system that allows users to manually provide Microsoft Graph access tokens and schedule emails to be sent to their contacts in bulk. The system must handle the ephemeral nature of these tokens (60–90 min expiry), implement fair resource allocation between users, provide proper rate limiting and retry mechanisms, and support both immediate and scheduled batch sends.

Email delivery confirmation is unavailable without `mail.read` — the system tracks Graph-accepted sends only.

---

## 2. CORE ARCHITECTURE DECISION

✅ **CONFIRMED**: pg_cron-triggered batch processing + scheduled batch support.
- `pg_cron` (`*/5 * * * *`) triggers `process-batches` edge function every 5 minutes
- `process-batches` queries pending + due-scheduled batches, processes them per-user with time slicing
- Separate cron (`* * * * *`) triggers `process-scheduled-individual` every 1 minute for scheduled individual sends (not batch)

✅ **JWT must be disabled** on `process-batches`, `process-scheduled-individual`, and `schedule-batch` (Supabase Dashboard → JWT OFF)

✅ **RLS must be disabled** on all tables: `batches`, `recipient_list`, `user_ms_graph_links`, `email_sends`, `contacts`, `send_attachments`, `email_events`, `memberships`

✅ **Token retrieval via direct Supabase query** — NOT via RPC. `supabase.from('user_ms_graph_links').select(...)` is used directly in the edge function. `get_token_status` and `get_ms_graph_access_token` RPCs fail when called from edge function HTTP context.

❌ REMOVED: StalenessChecker as separate component — staleness handling is embedded inline (lock TTL check)
❌ REMOVED: LangGraph-based workflow
❌ REMOVED: 1-hour cron frequency — confirmed as `*/5 * * * *` (every 5 minutes)

---

## 3. TECH STACK & TOOLING

- ✅ **Supabase Edge Function** (`process-batches`): Deno runtime, cron-triggered, handles batch send processing
- ✅ **Supabase Edge Function** (`process-scheduled-individual`): Deno runtime, cron-triggered every minute, handles scheduled individual emails
- ✅ **Supabase Edge Function** (`schedule-batch`): Deno runtime, HTTP-triggered from App, creates batch records
- ✅ **pg_cron** (`*/5 * * * *`): triggers `process-batches` every 5 minutes
- ✅ **pg_cron** (`* * * * *`): triggers `process-scheduled-individual` every 1 minute
- ✅ **pg_cron** (`*/30 * * * *`): triggers `reset-stuck-processing-locks` every 30 minutes
- ✅ **Supabase Postgres** tables: `batches`, `recipient_list`, `user_ms_graph_links`
- ✅ **RPC**: `get_pending_batches` — returns pending + due-scheduled batches
- ✅ **RPC**: `get_pending_recipients` — returns pending recipients for a batch
- ✅ **RPC**: `increment_send_count` — increments per-user send count after confirmed 202
- ✅ **RPC**: `update_batch_counts` — updates sent_count/failed_count, sets status=completed
- ✅ **RPC**: `log_email_event` — logs to email_events
- ✅ **RPC**: `schedule_batch` — creates batch + recipient_list entries, accepts optional `scheduled_at`
- ✅ **Microsoft Graph API** — `POST /me/sendMail` for email delivery; 202 = accepted only

---

## 4. DATA MODEL & FLOW

### Immediate Batch Send
1. User selects contact list, composes email, clicks "Send to List" in App UI
2. App calls `POST /functions/v1/schedule-batch` with list_id, subject, content
3. `schedule-batch` creates `batches` record with `status='pending'`
4. `schedule-batch` creates `recipient_list` entries for each contact
5. pg_cron (`*/5 * * * *`) triggers `process-batches` within 5 minutes
6. `process-batches` acquires per-user lock, processes recipients within time slice
7. On 202: increment send_count, mark recipient sent
8. On 401: mark token_expired, clear lock, skip user
9. On 429: store retry_after, clear lock, keep pending

### Scheduled Batch Send
1. User selects contact list, composes email, enables "Send Later", picks date/time
2. App calls `POST /functions/v1/schedule-batch` with `scheduled_at: <future_timestamp>`
3. `schedule_batch` RPC creates `batches` with `status='scheduled'` and `scheduled_at=<future>`
4. pg_cron (`*/5 * * * *`) checks `get_pending_batches()` which returns:
   - `status='pending'` batches immediately
   - `status='scheduled'` batches only when `scheduled_at <= now()`
5. Processing continues as normal once batch is picked up

### Scheduled Individual Send
1. User composes email, enables "Send Later", picks date/time, clicks "Schedule Email"
2. App calls `POST /functions/v1/send-individual` with `scheduled_at: <future_timestamp>`
3. `send-individual` inserts `email_sends` with `status='scheduled'`, returns immediately
4. pg_cron (`* * * * *`) triggers `process-scheduled-individual` every minute
5. `process-scheduled-individual` queries: `email_sends WHERE status='scheduled' AND send_at <= now()`
6. Sends each email via Graph API, updates status to `sent`/`failed`

### Key Entities

| Entity | Columns | Notes |
|--------|---------|-------|
| `batches` | `id`, `tenant_id`, `user_id`, `subject`, `content`, `attachments`, `status`, `scheduled_at`, `total_count`, `sent_count`, `failed_count` | `status`: pending/scheduled/processing/completed/failed |
| `recipient_list` | `id`, `batch_id`, `email`, `status`, `error_detail` | `status`: pending/sent/failed |
| `user_ms_graph_links` | `user_id`, `access_token`, `status`, `retry_after`, `processing_since`, `expires_at`, `send_count` | Lock: status=processing + processing_since |
| `email_sends` | `id`, `tenant_id`, `tracking_id`, `recipient_email`, `subject`, `status`, `send_at`, `sent_at` | Used for individual sends, NOT batch recipients |

### Time Slicing (confirmed implementation)
- **Total runtime budget**: 120 seconds per cron invocation
- **Per user**: `min(20 seconds, 110 / userCount seconds)`
- **Between send calls**: 200ms delay to respect rate limits
- Example: 3 users → 36s each max
- Batches not finished in this run are picked up in the next cron run (5 minutes later)

### Lock Mechanism
- `user_ms_graph_links.status='processing'` + `processing_since=now()` acts as per-user lock
- **Lock TTL**: 2 hours — if `processing_since < now() - 2 hours`, next run force-resets to `active`
- **In-flight detection**: if `status=processing` and `processing_since <= 2 hours ago`, skip user (previous run still active)

---

## 5. WORKFLOW & SEQUENCE

```
pg_cron (*/5 * * * *) → process-batches
    ↓
get_pending_batches() → pending + due-scheduled batches
    ↓
group by user_id → calculate timeSlice = min(20s, 110s / userCount)
    ↓
per userId:
    ├─ retry_after check → skip if active
    ├─ token_expired → batch.status=failed, skip user
    ├─ lock (status=processing):
    │   ├─ processing_since > 2hrs → force reset to active
    │   └─ processing_since <= 2hrs → skip user
    └─ status=active → acquire lock → process batches

per batch:
    ├─ update status=processing, started_at=now()
    ├─ get_pending_recipients(batch_id)
    ├─ per recipient: sendMail → update recipient_list
    └─ update_batch_counts (sets sent_count, failed_count, status=completed)

release lock (status=active, processing_since=null) if not token_expired
```

### Error Handling
- **Token expiration (401)**: `user_ms_graph_links.status='token_expired'`, clear lock, batch stays pending
- **Rate limiting (429)**: store `retry_after`, `status=active`, clear lock, batch stays pending
- **Lock TTL expired**: force-reset `status=active`, clear `processing_since`, reprocess
- **Lock in-flight**: skip user, wait for next cron run
- **Timeslice exhausted**: release lock, remaining recipients picked up in next cron run
- **SendCounter increments only on 202**: delivery to recipient unverifiable without `mail.read`

---

## 6. INTERFACE CONTRACTS

### Edge Function: `schedule-batch`
**JWT: Must be disabled**

Request body:
```json
{
  "list_id": "uuid",
  "subject": "Email Subject",
  "content": "<html>...</html>",
  "attachments": [{ "name": "file.pdf", "path": "path/in/storage" }],
  "scheduled_at": "2026-04-17T15:00:00Z"  // optional, if provided batch is scheduled
}
```

Response:
```json
{
  "success": true,
  "batch_id": "uuid",
  "total_count": 150,
  "status": "scheduled",  // or "pending" if immediate
  "scheduled_at": "4/17/2026, 3:00:00 PM"
}
```

### Edge Function: `process-batches`
**Trigger**: pg_cron `*/5 * * * *` via `net.http_post`
**JWT: Must be disabled**
**No request body** — processes all pending/due-scheduled batches

### Edge Function: `process-scheduled-individual`
**Trigger**: pg_cron `* * * * *` via `net.http_post`
**JWT: Must be disabled**
**No request body** — queries `email_sends WHERE status='scheduled' AND send_at <= now()`

---

## 7. CONFIRMED DESIGN DECISIONS

- ✅ **5-minute cron** — more responsive than 1-hour; confirmed via production testing
- ✅ **Per-user time slicing** — fair allocation across concurrent users
- ✅ **Lock mechanism with 2-hour TTL** — distinguishes crashed runs from slow ones
- ✅ **SendCounter increments only on 202** — avoids counting failed sends
- ✅ **Direct Supabase query for token** — NOT via RPC (RPC fails from edge function HTTP context)
- ✅ **JWT intentionally disabled** — service_role key used by cron; user-level access managed by App
- ✅ **RLS disabled on all tables** — required for service_role edge function access
- ✅ **Scheduled batch sends** — `scheduled_at` parameter on `schedule_batch` RPC
- ✅ **Scheduled individual sends** — `scheduled_at` parameter on `send-individual`, separate 1-min cron
- ✅ **Attachment cleanup safeguard** — files attached to active batches (pending/scheduled/processing) are protected from 10-day cleanup
- ✅ **200ms delay between sends** — respects Graph API rate limits

---

## 8. pg_cron Schedule Summary

| Job | Schedule | Purpose |
|-----|----------|---------|
| `process-email-batches-v2` | `*/5 * * * *` | Picks up pending + due-scheduled batches |
| `process-scheduled-individual` | `* * * * *` | Picks up scheduled individual email_sends |
| `reset-stuck-processing-locks` | `*/30 * * * *` | Force-resets locks older than 2 hours |
| `cleanup-old-records` | `0 * * * *` | Deletes files/records older than 10 days; active batch attachments protected |
| `hardbounced-check` | `0 * * * *` | Hourly bounce check |
| `reset-daily-send-counts` | `0 0 * * *` | Resets daily send counts at midnight UTC |

---

## 9. ARCHITECTURE GRAVEYARD

- ❌ 1-hour cron frequency — replaced by `*/5 * * * *`
- ❌ StalenessChecker as separate component — inline lock TTL check is sufficient
- ❌ Token retrieval via RPC — direct `supabase.from()` query works; RPC fails from edge function context
- ❌ `SET LOCAL ROLE NONE` inside SECURITY DEFINER functions — not allowed by PostgreSQL
- ❌ LangGraph-based workflow
- ❌ Separate notification service
- ❌ `mail.read` scope — delivery confirmation unavailable
- ❌ Vercel Edge Functions / Cron — replaced by Supabase Edge Functions + pg_cron
