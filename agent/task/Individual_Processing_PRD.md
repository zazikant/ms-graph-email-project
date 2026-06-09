# PRD: Microsoft Graph Individual Mail Send

## 1. PROBLEM STATEMENT

Build a system that allows users to compose and send a single email on demand using a manually provided Microsoft Graph access token. Two modes:
1. **Immediate**: user clicks send → email dispatched synchronously
2. **Scheduled**: user picks a future time → email dispatched automatically by cron

Tokens expire in 60–90 minutes, are manually pasted, and the system has no `mail.read` scope — delivery confirmation, bounce codes, and real quota usage are entirely unverifiable after Graph accepts the send.

---

## 2. CORE ARCHITECTURE DECISION

✅ **CONFIRMED**: Synchronous Edge Function (`send-individual`) triggered directly by App UI via HTTP POST.
- Immediate: function sends email and returns response synchronously
- Scheduled: function inserts `email_sends` with `status='scheduled'` and `send_at=<future_time>`, returns immediately. A separate cron (`process-scheduled-individual`) polls every minute for due scheduled emails.

✅ **JWT must be disabled** on `send-individual` (Supabase Dashboard → JWT OFF). The App sends the user's JWT for authentication, but the edge function does not enforce it — instead it relies on the App passing the user's `user_id` derived from the auth token.

✅ **RLS must be disabled** on all tables: `user_ms_graph_links`, `email_sends`, `contacts`, `send_attachments`, `email_events`, `memberships`.

❌ REMOVED: Cron-based triggering for immediate sends — no scheduling involved in immediate mode
❌ REMOVED: Batcher component — single mail per action, batching is unnecessary
❌ REMOVED: Time slice allocation — no multi-user fairness concern in a direct send
❌ REMOVED: Processing lock (`status=processing + processing_since`) — no long-running batch; request completes or fails in one cycle
❌ REMOVED: StalenessChecker — no long-running pending tasks to monitor

---

## 3. TECH STACK & TOOLING

- ✅ **Supabase Edge Function** (`send-individual`): Deno runtime, handles synchronous immediate send and scheduled insert
- ✅ **Supabase Edge Function** (`process-scheduled-individual`): Deno runtime, cron-triggered, polls for due scheduled emails
- ✅ **Supabase Edge Function** (`schedule-batch`): Deno runtime, creates batch records (not individual sends)
- ✅ **pg_cron** (`* * * * *`): triggers `process-scheduled-individual` every minute to pick up due scheduled emails
- ✅ **Supabase Postgres** tables: `user_ms_graph_links`, `email_sends`, `contacts`, `memberships`
- ✅ **RPC**: `increment_send_count` — increments per-user send count after confirmed 202
- ✅ **RPC**: `log_email_event` — logs sent/failed events to `email_events`
- ✅ **Microsoft Graph API** — `POST /me/sendMail`; 202 = accepted by Graph only, not confirmed delivery

---

## 4. DATA MODEL & FLOW

### Immediate Send Flow
1. User composes email, clicks "Send Email" in App UI
2. App calls `POST /functions/v1/send-individual` with recipient, subject, content, attachments, correlation_id
3. `send-individual` checks `user_ms_graph_links.status` — if `token_expired` → 403
4. `send-individual` checks `retry_after` — if still active → 429
5. `send-individual` checks `contacts.status='hardbounced'` — if true → 400
6. `send-individual` calls `POST /me/sendMail` to Graph API
7. On 202: `increment_send_count(userId)`, insert `email_sends` with `status='sent'`, `log_email_event`
8. On 401: update `user_ms_graph_links.status='token_expired'`
9. On 429: update `user_ms_graph_links.retry_after` with Retry-After timestamp

### Scheduled Send Flow
1. User composes email, enables "Send Later", picks date/time, clicks "Schedule Email"
2. App calls `POST /functions/v1/send-individual` with `scheduled_at: <future_ISO_timestamp>`
3. `send-individual` validates `scheduled_at > now()`
4. Inserts `email_sends` with `status='scheduled'`, `send_at=scheduled_at`
5. Returns `200 { scheduled: true, scheduled_at: "..." }` immediately — email NOT sent yet
6. pg_cron (`* * * * *`) triggers `process-scheduled-individual` every minute
7. `process-scheduled-individual` queries: `SELECT * FROM email_sends WHERE status='scheduled' AND send_at <= now() LIMIT 50`
8. For each due scheduled email: calls Graph API, updates `email_sends` to `sent`/`failed`

### Key Entities

| Entity | Columns | Notes |
|--------|---------|-------|
| `user_ms_graph_links` | `user_id`, `access_token`, `status`, `retry_after`, `expires_at`, `send_count` | `status`: active/token_expired/processing |
| `email_sends` | `id`, `tenant_id`, `tracking_id`, `recipient_email`, `subject`, `html_content`, `status`, `send_at`, `sent_at`, `user_id` | `status`: sent/failed/scheduled |
| `contacts` | `id`, `tenant_id`, `email`, `status` | `status='hardbounced'` blocks send |

---

## 5. WORKFLOW & SEQUENCE

### Immediate Send State Machine
```
user_compose_trigger
    ↓
token_status_check (→ 403 if token_expired)
    ↓
retry_after_check (→ 429 if rate limited)
    ↓
hardbounce_check (→ 400 if hardbounced)
    ↓
graph_send (POST /me/sendMail)
    ↓
response_handler
    ├─ 202 → increment_send_count + email_sends INSERT + log_email_event → 200
    ├─ 401 → update token_expired → 403
    ├─ 429 → update retry_after → 429
    └─ 4xx/5xx → email_sends INSERT failed + log_email_event → 500
```

### Scheduled Send State Machine
```
user_compose_trigger + scheduled_at
    ↓
validate scheduled_at > now()
    ↓
email_sends INSERT (status='scheduled', send_at=<future>)
    ↓
200 { scheduled: true } immediately

--- later, every 1 minute (cron) ---

process-scheduled-individual
    ↓
query: email_sends WHERE status='scheduled' AND send_at <= now()
    ↓
per email: graph_send → update status to sent/failed
```

### Error Handling
- **Token expiration (401)**: mark `user_ms_graph_links.status='token_expired'`, return 403
- **Rate limiting (429)**: store `retry_after` timestamp, return 429 with Retry-After header
- **Hardbounce check**: consult `contacts.status`, return 400 if `hardbounced`
- **Token already expired at send time**: check status before calling Graph, return 403 early
- **Retry-After still active**: return 429 early, before calling Graph

---

## 6. INTERFACE CONTRACTS

### Edge Function: `send-individual`

**JWT: Must be disabled**

Request body:
```json
{
  "recipient": "user@example.com",
  "subject": "Email Subject",
  "content": "<html><body>...</body></html>",
  "attachments": [{ "name": "file.pdf", "path": "path/in/storage" }],
  "correlation_id": "uuid",
  "scheduled_at": "2026-04-17T15:00:00Z"  // optional, if provided email is scheduled not sent immediately
}
```

Response (immediate):
```json
{ "success": true, "correlation_id": "uuid" }
```

Response (scheduled):
```json
{ "success": true, "scheduled": true, "scheduled_at": "4/17/2026, 3:00:00 PM", "send_id": "uuid" }
```

Response codes:
| Code | Meaning |
|------|---------|
| 200 | Sent successfully (immediate) or scheduled (future) |
| 400 | Hardbounced recipient |
| 403 | Token expired or not found |
| 429 | Rate limited by Microsoft Graph |
| 500 | Graph API error |

---

## 7. CONFIRMED DESIGN DECISIONS

- ✅ **SendCounter increments only on 202** — avoids counting failed sends
- ✅ **Hardbounce check before Graph call** — avoids wasting API quota on known bad addresses
- ✅ **Attachment support** — inline file attachments via Graph API
- ✅ **Tracking pixel** — injected into HTML content for open tracking
- ✅ **Scheduled sends** — `scheduled_at` parameter, separate cron processor
- ✅ **JWT intentionally disabled** — App uses service_role for edge function calls; user's identity comes from their JWT to the App only
- ✅ **RLS disabled on all tables** — required for service_role edge function access

---

## 8. ARCHITECTURE GRAVEYARD

- ❌ Vercel Edge Function — replaced by Supabase Edge Function
- ❌ Cron-based immediate send triggering
- ❌ Batcher component — single mail per action
- ❌ StalenessChecker — no long-running pending tasks
- ❌ Processing lock — synchronous flow completes in one request
- ❌ Time slice allocation — no multi-user concurrency in individual send
- ❌ `mail.read` scope — delivery confirmation unavailable; tracking pixel used for open confirmation only
