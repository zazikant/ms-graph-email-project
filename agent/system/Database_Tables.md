# Database Tables Reference

**All tables have RLS disabled.** Service role key is used for all access.

---

## Core Email Tables

### `email_sends`
Individual email send tracking. Used by `send-individual`, `process-scheduled-individual`, and `process-batches`.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `tenant_id` | uuid | YES | | FK → `tenants` (null = universal pending, visible to all admins) |
| `email` | text | NO | | |
| `status` | recipient_status (enum) | YES | `'pending'` | `pending\|sent\|failed\|skipped` |
| `error_detail` | text | YES | | |
| `created_at` | timestamptz | YES | `now()` | |
| `tracking_id` | uuid | YES | `gen_randomuuid()` | |
| `send_id` | uuid | YES | | FK → `email_sends` |

---

### `send_attachments`
Attachments sent with emails. Used by `send-individual`, `process-scheduled-individual`, and `process-batches`.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `send_id` | uuid | YES | | FK → `email_sends` |
| `file_name` | text | NO | | |
| `storage_path` | text | NO | | Supabase storage path |
| `content_type` | text | YES | | MIME type |
| `file_size` | bigint | YES | | |
| `created_at` | timestamptz | YES | `now()` | |

---

### `email_events`
Open/click tracking events. Used by `track-open-v2` and `track-click-v2`.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `send_id` | uuid | YES | | FK → `email_sends` |
| `tracking_id` | uuid | YES | | FK → `email_sends.tracking_id` |
| `event_type` | text | NO | | Check: `open\|click` |
| `clicked_url` | text | YES | | URL clicked |
| `recipient_ip` | text | YES | | IP of opener/clicker |
| `created_at` | timestamptz | YES | `now()` | |

---

## Token & User Tables

### `user_ms_graph_links`
Microsoft Graph access token storage. Per-user token state.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `user_id` | uuid | NO | | PK, FK → `auth.users` |
| `vault_secret_id` | uuid | YES | | Supabase Vault reference |
| `access_token` | text | YES | | The actual Graph token |
| `expires_at` | timestamptz | YES | | Token expiry |
| `status` | text | NO | `'active'` | Check: `active\|processing\|token_expired` |
| `retry_after` | timestamptz | YES | | Rate limit backoff |
| `send_count` | integer | NO | `0` | Sends in current window |
| `processing_since` | timestamptz | YES | | Lock: when processing started |
| `updated_at` | timestamptz | YES | `now()` | |

---

### `memberships`
Links users to tenants with roles.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `tenant_id` | uuid | YES | | FK → `tenants` |
| `user_id` | uuid | YES | | FK → `auth.users` |
| `role` | text | YES | `'member'` | `admin\|member` |
| `created_at` | timestamptz | YES | `now()` | |
| `ms_access_token` | text | YES | | (legacy?) |
| `ms_refresh_token` | text | YES | | (legacy?) |

---

### `users`
Mirror of `auth.users` for local reference.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | | PK, FK → `auth.users` |
| `email` | text | YES | | |
| `created_at` | timestamptz | YES | `now()` | |

---

### `invitations`
Pending invites to join a tenant. Supports "signup-first" flow where `tenant_id` can be null — these universal pending invites are visible to all admins and the approving admin adds the user to their own tenant.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `tenant_id` | uuid | NO | | FK → `tenants` |
| `email` | text | NO | | |
| `role` | text | NO | `'member'` | `admin\|member` |
| `status` | text | NO | `'pending'` | Check: `pending\|approved\|rejected` |
| `invited_by` | uuid | YES | | FK → `auth.users` |
| `created_at` | timestamptz | YES | `now()` | |
| `updated_at` | timestamptz | YES | `now()` | |

---

## Contact & List Tables

### `contacts`
All contacts.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `tenant_id` | uuid | NO | | FK → `tenants` |
| `email` | text | NO | | |
| `name` | text | YES | | |
| `tags` | text[] | YES | `'{}'` | |
| `list_id` | uuid | YES | | FK → `lists` (direct list assignment) |
| `status` | text | YES | `'subscribed'` | Check: `subscribed\|hardbounced\|unsubscribed` |
| `created_at` | timestamptz | YES | `now()` | |
| `updated_at` | timestamptz | YES | `now()` | |

---

### `lists`
Contact lists.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `tenant_id` | uuid | YES | | FK → `tenants` |
| `name` | text | NO | | |
| `created_at` | timestamptz | YES | `now()` | |
| `updated_at` | timestamptz | YES | `now()` | |

---

### `contact_lists`
Many-to-many join between contacts and lists.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `contact_id` | uuid | YES | | FK → `contacts` |
| `list_id` | uuid | YES | | FK → `lists` |
| `created_at` | timestamptz | YES | `now()` | |

---

## Organization Tables

### `tenants`
Organizations/companies.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `name` | text | NO | | |
| `created_at` | timestamptz | YES | `now()` | |
| `ms_client_id` | text | YES | | Azure AD app client ID |
| `ms_client_secret` | text | YES | | Azure AD app client secret |
| `ms_tenant_id` | text | YES | | Azure AD tenant ID |

---

## Logging Tables

### `email_audit`
High-level email send audit log. Legacy/unified log.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `tenant_id` | uuid | NO | | FK → `tenants` |
| `correlation_id` | uuid | YES | `gen_randomuuid()` | |
| `batch_id` | uuid | YES | | FK → `batches` |
| `scheduled_at` | timestamptz | YES | | |
| `sent_by` | uuid | YES | | FK → `auth.users` |
| `recipient` | text | NO | | |
| `subject` | text | YES | | |
| `status` | email_status (enum) | NO | `'pending'` | `draft\|pending\|sending\|sent\|failed\|delivered\|bounced` |
| `sent_at` | timestamptz | YES | | |
| `created_at` | timestamptz | YES | `now()` | |
| `updated_at` | timestamptz | YES | `now()` | |
| `attachment_refs` | uuid[] | YES | | |
| `metadata` | jsonb | YES | `'{}'` | |
| `error_detail` | text | YES | | |
| `tracking_pixel_url` | text | YES | | |
| `open_tracked` | boolean | YES | `false` | |
| `click_count` | integer | YES | `0` | |

---

### `graph_api_log`
Graph API call logs.

| Column | Type | Nullable | Default | Notes |
|--------|------|---------|---------|-------|
| `id` | uuid | NO | `gen_randomuuid()` | PK |
| `tenant_id` | uuid | NO | | FK → `tenants` |
| `email_audit_id` | uuid | YES | | FK → `email_audit` |
| `correlation_id` | uuid | NO | | |
| `created_at` | timestamptz | YES | `now()` | |
| `endpoint` | text | NO | | Graph API endpoint |
| `http_method` | text | NO | | GET/POST/etc |
| `status` | api_call_status (enum) | NO | | `success\|failure\|retry` |
| `request_body` | jsonb | YES | | |
| `response_body` | jsonb | YES | | |
| `http_status` | integer | YES | | |
| `error_message` | text | YES | | |
| `invoked_by` | uuid | YES | | FK → `auth.users` |

---

## Enum Types

| Enum Name | Values |
|-----------|--------|
| `batch_status` | `pending`, `scheduled`, `processing`, `completed`, `paused`, `failed` |
| `recipient_status` | `pending`, `sent`, `failed`, `skipped` |
| `email_status` | `draft`, `pending`, `sending`, `sent`, `failed`, `delivered`, `bounced` |
| `api_call_status` | `success`, `failure`, `retry` |

---

## Check Constraints

| Table | Column | Constraint |
|-------|--------|------------|
| `user_ms_graph_links` | `status` | `active`, `processing`, `token_expired` |
| `contacts` | `status` | `subscribed`, `hardbounced`, `unsubscribed` |
| `invitations` | `status` | `pending`, `approved`, `rejected` |
| `email_sends` | `status` | `draft`, `scheduled`, `processing`, `sent`, `failed` |
| `email_events` | `event_type` | `open`, `click` |
