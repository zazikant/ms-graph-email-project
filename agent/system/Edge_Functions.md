# Edge Functions Reference

**JWT must be disabled** on all cron-triggered functions: `process-batches`, `process-scheduled-individual`.
**JWT must be enabled** on user-facing functions: `send-individual`, `schedule-batch`, `manage-token`, `delete-user`.

**All tables have RLS disabled.** Service role key used internally.

---

## `send-individual`

**Purpose**: Send a single email immediately, or schedule it for later.

**Trigger**: HTTP POST from App UI (user action)
**JWT**: Enabled (user-facing)
**Auth**: User's JWT via App → edge function

### Request

```json
{
  "recipient": "user@example.com",
  "subject": "Email Subject",
  "content": "<html><body>...</body></html>",
  "attachments": [{ "name": "file.pdf", "path": "path/in/storage" }],
  "correlation_id": "uuid",
  "scheduled_at": "2026-04-17T15:00:00Z"   // optional — if provided, email is scheduled
}
```

### Response

| Status | Body |
|--------|------|
| 200 | `{ "success": true, "correlation_id": "uuid" }` (immediate) |
| 200 | `{ "success": true, "scheduled": true, "scheduled_at": "...", "send_id": "uuid" }` (scheduled) |
| 400 | `{ "error": "...", "code": "hardbounced" }` |
| 403 | `{ "error": "Token expired or not found", "code": "token_expired" }` |
| 429 | `{ "error": "Rate limited", "retry_after_seconds": 3600 }` |
| 500 | `{ "error": "..." }` |

### Tables Used
- `user_ms_graph_links` — token retrieval (direct query, NOT RPC)
- `contacts` — hardbounce check
- `email_sends` — insert before send, update after
- `send_attachments` — insert on success
- `memberships` — tenant_id lookup

### RPCs Called
- `increment_send_count(user_id)` — on 202 from Graph
- `log_email_event(tenant_id, correlation_id, sent_by, recipient, subject, status, error_detail, metadata)` — 8-arg version

### Flow
1. Validate `scheduled_at` — if future time provided, insert `email_sends` with `status='scheduled'` and return immediately
2. Check `user_ms_graph_links.status` — if `token_expired` → 403
3. Check `retry_after` — if still active → 429
4. Check `contacts.status` — if `hardbounced` → 400
5. Call `POST /me/sendMail` to Graph
6. On 202: `increment_send_count`, insert/update `email_sends`, `log_email_event`, `send_attachments`
7. On 401: update `user_ms_graph_links.status='token_expired'`
8. On 429: update `user_ms_graph_links.retry_after`

### Local File
`supabase/functions/send-individual/index.ts`

---

## `process-batches`

**Purpose**: Process pending and scheduled batch sends. Picks up from where it left off across cron runs.

**Trigger**: pg_cron `*/5 * * * *` → `net.http_post` with service_role auth
**JWT**: Disabled
**Auth**: Service role key (cron sends it)

### Request
No body — processes all pending/due-scheduled batches.

### Response

```json
{
  "processed": 3,
  "results": [
    {
      "batch_id": "uuid",
      "user_id": "uuid",
      "sent": 150,
      "failed": 2,
      "skipped": 0
    }
  ]
}
```

### Key Behavior

| Condition | Action |
|-----------|--------|
| `user_ms_graph_links.status = token_expired` | Batch → `failed`, skip user |
| `retry_after > now()` | Skip user (rate limited) |
| `status = processing AND processing_since > 2hrs` | Force-reset to `active` |
| `status = processing AND processing_since <= 2hrs` | Skip user (in-flight) |
| `status = active` | Acquire lock, process |
| Graph 202 | Increment count, mark sent |
| Graph 401 | `status=token_expired`, clear lock, break |
| Graph 429 | Store `retry_after`, clear lock, break |

### Time Slicing
- Total budget: **120 seconds**
- Per user: `min(20, 110 / userCount)` seconds
- Delay between sends: **200ms**

### Tables Used
- `batches` — SELECT via `get_pending_batches`, UPDATE status
- `recipient_list` — SELECT via `get_pending_recipients`, UPDATE status
- `user_ms_graph_links` — SELECT (direct query), UPDATE status/lock
- `contacts` — not used in batch (no hardbounce check)
- `email_sends` — INSERT per recipient sent
- `send_attachments` — INSERT on success
- `memberships` — tenant_id lookup

### RPCs Called
- `get_pending_batches()` — returns pending + due-scheduled batches
- `get_pending_recipients(batch_id)` — returns pending recipients
- `increment_send_count(user_id)` — on 202
- `update_batch_counts(batch_id)` — updates counts, sets `status=completed`
- `log_email_event(...)` — 8-arg version

### Local File
`supabase/functions/process-batches/index.ts`

---

## `process-scheduled-individual`

**Purpose**: Pick up and send individual emails where `send_at` has passed.

**Trigger**: pg_cron `* * * * *` (every minute) → `net.http_post`
**JWT**: Disabled
**Auth**: Service role key

### Request
No body.

### Response

```json
{
  "processed": 5,
  "results": [
    {
      "send_id": "uuid",
      "recipient": "user@example.com",
      "status": "sent"
    }
  ]
}
```

### Flow
1. Query: `SELECT * FROM email_sends WHERE status='scheduled' AND send_at <= now() LIMIT 50`
2. Group by user_id
3. Per user: get token via direct query (NOT RPC)
4. Call Graph API, update `email_sends` to `sent`/`failed`
5. `increment_send_count` on success
6. `log_email_event` on both sent/failed

### Tables Used
- `email_sends` — SELECT pending, UPDATE to sent/failed
- `user_ms_graph_links` — token retrieval (direct query)
- `memberships` — tenant_id lookup

### RPCs Called
- `increment_send_count(user_id)`
- `log_email_event(...)` — 8-arg version

### Local File
`supabase/functions/process-scheduled-individual/index.ts`

---

## `schedule-batch`

**Purpose**: Create a batch send record and populate recipient_list.

**Trigger**: HTTP POST from App UI
**JWT**: Enabled (user-facing)

### Request

```json
{
  "list_id": "uuid",
  "subject": "Batch Email Subject",
  "content": "<html><body>...</body></html>",
  "attachments": [{ "name": "file.pdf", "path": "path" }],
  "scheduled_at": "2026-04-17T15:00:00Z"   // optional
}
```

### Response

```json
{
  "success": true,
  "batch_id": "uuid",
  "total_count": 150,
  "status": "scheduled",
  "scheduled_at": "4/17/2026, 3:00:00 PM",
  "message": "Batch scheduled for 4/17/2026, 3:00:00 PM. Processing will begin automatically at that time."
}
```

### Flow
1. Validate user token (check `user_ms_graph_links`)
2. Call `schedule_batch` RPC with optional `scheduled_at`
3. Return batch info

### RPCs Called
- `schedule_batch(p_user_id, p_tenant_id, p_list_id, p_subject, p_content, p_attachments, p_scheduled_at)`
  - If `scheduled_at > now()` → `status='scheduled'`
  - Otherwise → `status='pending'`
  - Creates batch + populates `recipient_list` from contacts in the list

### Tables Used
- `memberships` — tenant_id, user_id lookup
- `user_ms_graph_links` — token status check

### Local File
`supabase/functions/schedule-batch/index.ts`

---

## `manage-token`

**Purpose**: CRUD operations for the user's Microsoft Graph access token.

**Trigger**: HTTP (GET/PUT/DELETE) from App UI (Settings tab)
**JWT**: Enabled — requires valid user JWT

### Endpoints

#### PUT — Save/Update token
**Request:**
```json
{ "access_token": "eyJ..." }
```
**Response:** `{ "success": true, "status": "active" }`
**RPC:** `store_ms_graph_access_token(user_id, access_token)`

#### GET — Check token status
**Response:**
```json
{
  "has_token": true,
  "status": "active",
  "retry_after": null,
  "send_count": 5,
  "expires_at": "2026-04-17T12:00:00Z"
}
```
**RPC:** `get_token_status(user_id)`

#### DELETE — Remove token
**Response:** `{ "success": true }`
**RPC:** `delete_ms_graph_token(user_id)`

### Tables Used
- `user_ms_graph_links` — read/write token

### RPCs Called
- `store_ms_graph_access_token(p_user_id, p_access_token)` — SECURITY DEFINER
- `get_token_status(p_user_id)` — SECURITY DEFINER — returns `(token_exists, status, retry_after, send_count, expires_at)`
- `delete_ms_graph_token(p_user_id)` — SECURITY DEFINER

### Local File
`supabase/functions/manage-token/index.ts`

---

## `maybe-hardbounced`

**Purpose**: Detect genuinely failed emails (non-token-related) and mark those contacts as `hardbounced`.

**Trigger**: pg_cron `0 * * * *` (hourly)
**JWT**: Disabled
**Auth**: Service role key

### Logic
1. For each tenant, find `email_sends` from last 24hrs with `status=failed`
2. Filter out failures with token-related keywords: `token`, `401`, `AuthenticationError`, `refresh`, `expired`, `revoked`
3. Remaining failures → update `contacts.status = 'hardbounced'` for those emails
4. Tokens that failed due to auth issues don't mean the recipient address is bad, so they're excluded

### Response
```json
{ "success": true, "message": "Updated 3 contacts to hardbounced" }
```

### Tables Used
- `tenants` — list all tenants
- `email_sends` — find recent failures
- `contacts` — update to hardbounced

### Local File
`supabase/functions/maybe-hardbounced/index.ts`

---

## `delete-user`

**Purpose**: Admin deletes a user from their tenant.

**Trigger**: HTTP POST from App UI
**JWT**: Enabled

### Request
```json
{
  "email": "user@example.com",
  "tenant_id": "uuid",
  "requesting_user_id": "uuid"
}
```

### Response
```json
{ "success": true }
```

### Auth
Only users with `role = 'admin'` in `memberships` can delete.

### Flow
1. Verify requesting user is admin of the tenant
2. Find user by email in `users` table
3. Delete from `memberships`
4. Delete from `users`
5. Delete from `auth.users` via Admin API

### Tables Used
- `memberships` — verify admin role, delete
- `users` — delete user record
- `auth.users` — delete via Admin API

### Local File
`supabase/functions/delete-user/index.ts`

---

## `track-open-v2`

**Purpose**: Record when a recipient opens an email (tracking pixel loaded).

**Trigger**: HTTP GET — `<tracking_pixel_url>?tid=<tracking_id>`
**JWT**: Disabled (public)

### Response
1x1 transparent GIF (empty 1x1 PNG as fallback).

### Flow
1. Parse `tracking_id` from query param
2. Find `email_sends` by `tracking_id`
3. Insert into `email_events` with `event_type='open'`
4. Increment `email_sends.open_count`
5. Return transparent pixel

### Tables Used
- `email_sends` — find by tracking_id, increment open_count
- `email_events` — insert open event

### Notes
No local source file in project — deployed separately.

---

## `track-click-v2`

**Purpose**: Record when a recipient clicks a tracked link.

**Trigger**: HTTP GET — `<track_click_url>?tid=<tracking_id>&url=<clicked_url>`
**JWT**: Disabled (public)

### Response
302 redirect to the actual clicked URL.

### Flow
1. Parse `tracking_id` and `clicked_url` from query params
2. Find `email_sends` by `tracking_id`
3. Insert into `email_events` with `event_type='click'`, `clicked_url`
4. Increment `email_sends.click_count`
5. Redirect to original URL

### Tables Used
- `email_sends` — find by tracking_id, increment click_count
- `email_events` — insert click event

### Notes
No local source file in project — deployed separately.

---

## Summary Table

| Function | Trigger | JWT | Purpose |
|----------|---------|-----|---------|
| `send-individual` | App UI POST | ON | Send or schedule single email |
| `process-batches` | pg_cron `*/5 * * *` | OFF | Process batch sends |
| `process-scheduled-individual` | pg_cron `* * * * *` | OFF | Process scheduled individual emails |
| `schedule-batch` | App UI POST | ON | Create batch send record |
| `manage-token` | App UI GET/PUT/DELETE | ON | Token CRUD |
| `maybe-hardbounced` | pg_cron `0 * * * *` | OFF | Hardbounce detection |
| `delete-user` | App UI POST | ON | Remove user from tenant |
| `track-open-v2` | HTTP GET (public) | OFF | Open tracking pixel |
| `track-click-v2` | HTTP GET (public) | OFF | Click tracking redirect |
