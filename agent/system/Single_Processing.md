# Individual Send — Sequence Diagram

> **Actual implementation.** Edge function: `send-individual`
> **JWT must be disabled** on this function (Supabase Dashboard → Edge Functions → send-individual → JWT: OFF)
> **RLS must be disabled** on `user_ms_graph_links`, `email_sends`, `contacts`, `send_attachments`, `email_events`, `memberships`

---

## Two Modes

### Mode 1: Immediate Send

sequenceDiagram
    actor U as User
    participant App as App UI
    participant EdgeFn as send-individual
    participant TokenStore as user_ms_graph_links
    participant Contacts as contacts
    participant Graph as Microsoft Graph API
    participant SendCounter as increment_send_count RPC
    participant EmailSends as email_sends
    participant Audit as log_email_event RPC

    U->>App: Compose email, click "Send Email"
    App->>EdgeFn: POST /functions/v1/send-individual (JWT disabled)
    EdgeFn->>EdgeFn: Validate input, get userId from JWT

    EdgeFn->>TokenStore: SELECT status, expires_at FROM user_ms_graph_links WHERE user_id=?

    alt Token not found or status = token_expired
        EdgeFn-->>App: 403 token_expired
    end

    alt retry_after is set and retry_after > now()
        EdgeFn-->>App: 429 rate_limited
    end

    alt Recipient is hardbounced
        EdgeFn-->>App: 400 hardbounced
    end

    EdgeFn->>Graph: POST /me/sendMail
    alt 202 Accepted
        Graph-->>EdgeFn: 202
        EdgeFn->>SendCounter: increment_send_count(userId)
        EdgeFn->>EmailSends: INSERT status=sent, sent_at=now()
        EdgeFn->>Audit: log_email_event(tenant_id, sent)
        EdgeFn-->>App: 200 success
    else 401 Unauthorized
        Graph-->>EdgeFn: 401
        EdgeFn->>TokenStore: UPDATE status=token_expired
        EdgeFn-->>App: 403 token_expired
    else 429 Too Many Requests
        Graph-->>EdgeFn: 429 + Retry-After header
        EdgeFn->>TokenStore: UPDATE retry_after
        EdgeFn-->>App: 429 rate_limited
    else Other error
        Graph-->>EdgeFn: 4xx/5xx
        EdgeFn->>EmailSends: INSERT status=failed
        EdgeFn->>Audit: log_email_event(tenant_id, failed)
        EdgeFn-->>App: 500 send_failed
    end

---

### Mode 2: Scheduled Send

> When `scheduled_at` (future ISO timestamp) is provided in the request body.

sequenceDiagram
    actor U as User
    participant App as App UI
    participant EdgeFn as send-individual
    participant EmailSends as email_sends

    U->>App: Compose email, enable "Send Later", pick date/time, click "Schedule Email"
    App->>EdgeFn: POST /functions/v1/send-individual { scheduled_at: "2026-04-17T15:00:00Z" }
    EdgeFn->>EdgeFn: Validate scheduled_at > now()
    EdgeFn->>EmailSends: INSERT status=scheduled, send_at=scheduled_at
    EdgeFn-->>App: 200 { scheduled: true, scheduled_at: "..." }
    Note over EdgeFn: Returns immediately. Email NOT sent yet.

    Note over App: User sees "Email scheduled for..."

    loop Every 1 minute (pg_cron)
        participant Cron as process-scheduled-individual cron
        Cron->>EdgeFn: Calls process-scheduled-individual
        EdgeFn->>EmailSends: SELECT * FROM email_sends WHERE status=scheduled AND send_at <= now() LIMIT 50
        EdgeFn->>TokenStore: Get token for each user
        EdgeFn->>Graph: POST /me/sendMail
        EdgeFn->>EmailSends: UPDATE status=sent/failed
    end

---

## Implementation Notes

### Edge Function: `send-individual`
- **File**: `supabase/functions/send-individual/index.ts`
- **Trigger**: HTTP POST from App UI (user action)
- **JWT**: Must be **disabled** (Supabase Dashboard → JWT OFF)
- **RLS**: All involved tables have RLS **disabled**

### Key RPCs & Tables Used

| Component | Purpose |
|-----------|---------|
| `user_ms_graph_links` | Stores token, status, retry_after, processing_since, expires_at |
| `contacts` | Hardbounce check before sending |
| `email_sends` | Insert before send, update with final status after |
| `increment_send_count` RPC | Increments user's `send_count` on success (202) |
| `log_email_event` RPC | Logs sent/failed events to email_events |

### Token Status Values (actual column: `user_ms_graph_links.status`)
- `active` — token valid, not in use
- `token_expired` — token rejected by Graph (401)
- `processing` — lock held during batch send (not used in individual send)
- `retry_after` (column) — timestamp after which the user can send again

### No Batch/Queue/Slice in Individual Send
- No cron involvement for immediate sends
- No time-slice fairness logic (single user, single send)
- No lock mechanism (request completes in one cycle)
- No staleness checker (no long-running pending state)

### Scheduled Send Flow
- `scheduled_at` parameter: if provided and in the future, inserts `email_sends` with `status='scheduled'` and returns immediately
- `process-scheduled-individual` (cron `* * * * *`) polls every minute for ready `scheduled` emails and sends them
- Cron → `net.http_post` → `process-scheduled-individual` edge function (JWT disabled)

### Response Codes

| Code | Meaning |
|------|---------|
| 200 | Email sent (immediate) or scheduled (scheduled mode) |
| 400 | Hardbounced recipient |
| 401 | Token rejected by Graph (marked token_expired) |
| 403 | No token found or token_expired before call |
| 429 | Rate limited by Microsoft Graph |
| 500 | Graph API error |
