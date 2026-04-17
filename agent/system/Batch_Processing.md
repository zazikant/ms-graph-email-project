# Batch Send — Sequence Diagram

> **Actual implementation.** Edge function: `process-batches`
> **JWT must be disabled** on this function (Supabase Dashboard → Edge Functions → process-batches → JWT: OFF)
> **RLS must be disabled** on `batches`, `recipient_list`, `user_ms_graph_links`, `contacts`, `email_sends`, `send_attachments`, `email_events`, `memberships`

---

## Two Triggers

### Trigger 1: Immediate (pending batches)
`schedule-batch` creates a batch with `status='pending'`. The cron picks it up within 5 minutes.

### Trigger 2: Scheduled (future time)
`schedule-batch` with `scheduled_at` parameter creates a batch with `status='scheduled'`. The cron only picks it up when `scheduled_at <= now()`.

---

## Processing Sequence

sequenceDiagram
    actor U as User
    participant App as App UI
    participant EdgeFn as process-batches
    participant Cron as pg_cron
    participant BatchStore as batches
    participant RecipientStore as recipient_list
    participant TokenStore as user_ms_graph_links
    participant SendCounter as increment_send_count RPC
    participant Graph as Microsoft Graph API
    participant EmailSends as email_sends
    participant Audit as log_email_event RPC
    participant SchedCron as pg_cron (1min)

    Note over App: User schedules batch send via Compose tab
    App->>BatchStore: INSERT batch (status=pending OR scheduled)
    App->>RecipientStore: INSERT recipient_list entries
    App-->>U: batch_id returned

    Note over SchedCron: Every 1 minute (process-scheduled-individual)
    SchedCron->>EdgeFn: net.http_post → process-scheduled-individual
    Note over EdgeFn: Picks up email_sends with status=scheduled AND send_at <= now()
    Note over EdgeFn: NOT related to batches — separate flow

    Note over Cron: Every 5 minutes
    Cron->>EdgeFn: net.http_post → process-batches (JWT disabled)

    EdgeFn->>BatchStore: SELECT * FROM get_pending_batches()
    Note over EdgeFn: get_pending_batches returns:<br/>status='pending' OR<br/>(status='scheduled' AND scheduled_at <= now())

    EdgeFn->>EdgeFn: Group batches by user_id<br/>timeSlice = min(20s, 110s / userCount)<br/>Total budget = 120s

    loop Per userId
        EdgeFn->>TokenStore: SELECT access_token, status, retry_after, processing_since<br/>FROM user_ms_graph_links WHERE user_id=?

        alt status = token_expired
            EdgeFn->>BatchStore: UPDATE batch status=failed
            EdgeFn->>EdgeFn: Continue to next userId
        end

        alt retry_after > now()
            EdgeFn->>EdgeFn: Skip userId, rate limited
        end

        alt status = processing AND processing_since > 2hrs ago
            EdgeFn->>TokenStore: Force reset: status=active, processing_since=null
            Note over EdgeFn: Lock TTL expired — force reset
        end

        alt status = processing AND processing_since <= 2hrs ago
            EdgeFn->>EdgeFn: Skip userId, previous run still in-flight
        end

        alt status = active
            EdgeFn->>TokenStore: UPDATE status=processing, processing_since=now()

            loop Per batch for this userId
                EdgeFn->>BatchStore: UPDATE batch status=processing, started_at=now()
                EdgeFn->>RecipientStore: SELECT * FROM get_pending_recipients(batch_id)

                loop Per pending recipient
                    EdgeFn->>Graph: POST /me/sendMail
                    alt 202 Accepted
                        Graph-->>EdgeFn: 202
                        EdgeFn->>RecipientStore: UPDATE status=sent
                        EdgeFn->>SendCounter: increment_send_count(userId)
                        EdgeFn->>EmailSends: INSERT status=sent, sent_at=now()
                        EdgeFn->>Audit: log_email_event(tenant_id, sent)
                    else 401 Unauthorized
                        Graph-->>EdgeFn: 401
                        EdgeFn->>TokenStore: UPDATE status=token_expired, processing_since=null
                        EdgeFn->>EdgeFn: Break loop for this user
                    else 429 Too Many Requests
                        Graph-->>EdgeFn: 429 + Retry-After
                        EdgeFn->>TokenStore: UPDATE retry_after, status=active, processing_since=null
                        EdgeFn->>EdgeFn: Break loop for this user
                    else Other error
                        Graph-->>EdgeFn: 4xx/5xx
                        EdgeFn->>RecipientStore: UPDATE status=failed, error_detail=?
                        EdgeFn->>EmailSends: INSERT status=failed
                        EdgeFn->>Audit: log_email_event(tenant_id, failed)
                    end
                    Note over EdgeFn: 200ms delay between sends to respect rate limits
                end

                EdgeFn->>BatchStore: UPDATE batch counts via update_batch_counts RPC
                Note over EdgeFn: update_batch_counts sets sent_count, failed_count, status=completed
            end

            EdgeFn->>TokenStore: UPDATE status=active, processing_since=null (if not token_expired)
        end
    end

    EdgeFn-->>Cron: 200 { processed: N, results: [...] }
    Note over Cron: Results logged; any failures captured in batches.status

---

## Implementation Notes

### Edge Functions
| Function | Trigger | JWT | File |
|----------|---------|-----|------|
| `process-batches` | pg_cron `*/5 * * * *` | OFF | `supabase/functions/process-batches/index.ts` |
| `process-scheduled-individual` | pg_cron `* * * * *` | OFF | `supabase/functions/process-scheduled-individual/index.ts` |
| `schedule-batch` | HTTP POST from App | OFF | `supabase/functions/schedule-batch/index.ts` |

### Key RPCs & Tables

| Component | Purpose |
|-----------|---------|
| `batches` | Batch records with status, subject, content, attachments, scheduled_at |
| `recipient_list` | Per-batch recipient emails with status (pending/sent/failed) |
| `user_ms_graph_links` | Token storage, status, retry_after, processing_since lock |
| `email_sends` | Per-recipient send tracking (individual sends only, not batch) |
| `increment_send_count` RPC | Increments user's `send_count` on 202 |
| `get_pending_batches` RPC | Returns pending + due-scheduled batches |
| `get_pending_recipients` RPC | Returns pending recipients for a batch |
| `update_batch_counts` RPC | Recounts sent/failed, sets status=completed when done |
| `log_email_event` RPC | Logs to email_events table |

### Time Slicing (confirmed)
- **Total runtime budget**: 120 seconds
- **Per user**: `min(20, 110 / userCount)` seconds
- Example: 5 users → 22s each max
- Cron runs every 5 minutes, so batches not finished in this run get picked up in the next run

### Lock Mechanism
- `status=processing` + `processing_since=now()` on `user_ms_graph_links`
- **Lock TTL**: 2 hours — if `processing_since < now() - 2hrs`, next run force-resets to `active`
- **In-flight detection**: if lock is `active` and `processing_since > 2hrs ago`, skip user

### Token Retrieval — Direct Query (NOT RPC)
> **Critical fix**: The edge function uses `supabase.from('user_ms_graph_links').select(...)` directly. It does NOT call `get_token_status` or `get_ms_graph_access_token` RPCs — those fail from edge function HTTP context.

### Batch Status Values (`batches.status` — enum type)
- `pending` — created, waiting for cron
- `scheduled` — created with future `scheduled_at`, cron picks up when time is due
- `processing` — cron picked up, currently sending
- `completed` — all recipients processed
- `failed` — token unavailable or unrecoverable error
- `paused` — not implemented

### Recipient Status Values (`recipient_list.status`)
- `pending` — waiting to be sent
- `sent` — successfully sent
- `failed` — failed (error stored in `error_detail`)
- `skipped` — not implemented

### Cleanup (hourly — `cleanup-old-records`)
- Deletes `storage.objects` older than 10 days
- **Protected**: files attached to batches with `status IN (pending, scheduled, processing)` are NOT deleted
- Cascade deletes: `send_attachments` → `email_events` → `email_sends` for records older than 10 days

### pg_cron Jobs

| Job | Schedule | Purpose |
|-----|----------|---------|
| `process-email-batches-v2` | `*/5 * * * *` | Picks up pending + due-scheduled batches |
| `process-scheduled-individual` | `* * * * *` | Picks up scheduled individual email_sends |
| `reset-stuck-processing-locks` | `*/30 * * * *` | Force-resets locks older than 2 hours |
| `cleanup-old-records` | `0 * * * *` | Hourly cleanup of old files/records |
