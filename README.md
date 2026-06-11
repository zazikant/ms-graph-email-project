# Send Mail via API

Step 1 — Get your Supabase JWT (by logging in):

POST https://<your-supabase-url>/auth/v1/token?grant_type=password
Content-Type: application/json
apikey: <your-supabase-anon-key>

{ "email": "your@email.com", "password": "yourpassword" }

Step 2 — Send the email:


POST https://<your-supabase-url>/functions/v1/send-individual
Authorization: Bearer <jwt-from-step-1>
Content-Type: application/json

{
  "recipient": "target@example.com",
  "subject": "Hello from Graph",
  "content": "<html><body><p>Hi there!</p></body></html>",
  "correlation_id": "any-uuid-for-tracking"
}

====

# Send Mail directly or scheduled way to Batch via API

Here are the exact steps to send a batch to an existing list:

Step 1 — Get your Supabase JWT (same as before)
POST https://<your-supabase-url>/auth/v1/token?grant_type=password
Content-Type: application/json
apikey: <your-supabase-anon-key>
{ "email": "your@email.com", "password": "yourpassword" }

→ Save the access_token from the response

Step 2 — Find your List ID
Your lists live in the lists table. Query them via the Supabase REST API:

GET https://<your-supabase-url>/rest/v1/lists?select=id,name
Authorization: Bearer <jwt-from-step-1>
apikey: <your-supabase-anon-key>

Response will look like:

[
  { "id": "abc123-...", "name": "My Contact List" },
  { "id": "def456-...", "name": "Newsletter Subscribers" }
]

→ Copy the id of the list you want to send to

Step 3 — Schedule the Batch
POST https://<your-supabase-url>/functions/v1/schedule-batch
Authorization: Bearer <jwt-from-step-1>
Content-Type: application/json
{
  "list_id": "<id-from-step-2>",
  "subject": "Your email subject",
  "content": "<html><body><p>Your message here</p></body></html>"
}

Response:

{
  "success": true,
  "batch_id": "some-uuid",
  "total_count": 42,
  "status": "pending",
  "message": "Batch queued! Processing will begin shortly."
}

The batch will be picked up automatically by the cron job within 5 minutes and emails will start sending.

Optional: Schedule for a future time
Add scheduled_at to Step 3 to send later instead of immediately:

{
  "list_id": "<id-from-step-2>",
  "subject": "Your email subject",
  "content": "<html><body><p>Your message</p></body></html>",
  "scheduled_at": "2026-06-12T09:00:00Z"
}

The status will come back as "scheduled" and the cron will only pick it up at that time.

Key difference from individual send: instead of a recipient address, you pass a list_id — the system reads all subscribed contacts in that list and queues them all.

=======================

# Interesting Aspect

Smart Batch Processing - For the method only deploying mails using token that is not via Azure AD. When token gets expired, the batch stops sending emails and gets in "pending" mode. But, As the token is pasted.. The mails are resumed "processing" in about 5-10 minutes. 


# Azure AD steps

The flow for a new tenant:
1. New user signs up → creates a new tenant in the tenants table (empty Azure AD fields)
2. They go to Settings tab → follow the same 7-step guide you did:
  - Register an Azure AD app in their company's Azure portal
  - Get their own client_id, client_secret, tenant_id
  - Save it via the Settings page (stored in their tenants row)
3. They click "Connect with Microsoft" → OAuth flow uses their Azure AD app credentials
4. Token stored in their user_ms_graph_links row → tied to their user_id

| What | Where stored | Scope |
|------|-------------|-------|
| Azure AD credentials (`ms_client_id`, `ms_client_secret`, `ms_tenant_id`) | `tenants` table → **per tenant** | Each company has its own row |
| OAuth tokens (access + refresh) | `user_ms_graph_links` table → **per user** | Each user has their own row |
| Contacts, lists, files | All filtered by `tenant_id` | Complete data isolation |
| Email sends | All filtered by `tenant_id` | Complete data isolation |

The edge functions dynamically fetch credentials using tenant.ms_client_id, tenant.ms_client_secret, tenant.ms_tenant_id from the current user's tenant — never hardcoded. So Company A (gem-engserv.net) and Company B (acme.com) each use their own Azure AD app, their own tokens, and their own data. Completely isolated! 🏢✅



# manual sql query to set up Azure Credentials from supabase. just run this queey and batch mails automatically sent.

That's the problem! Your Azure AD credentials are **not stored in the `tenants` table** — they're all null. That's why server-side token refresh keeps failing.

Your tenant ID is `d15bd162-02e7-4854-bfec-5f055a64903a`. You need to fill in your actual Azure AD values. Run this in SQL Editor — replace the placeholder values with your real ones:

ms_client_secret is the value of secret key that is only visible one time . it is not the secret id.

```sql
UPDATE tenants 
SET ms_client_id = 'YOUR_ACTUAL_CLIENT_ID',
    ms_client_secret = 'YOUR_ACTUAL_CLIENT_SECRET',
    ms_tenant_id = 'YOUR_ACTUAL_AZURE_TENANT_ID'
WHERE id = 'd15bd162-02e7-4854-bfec-5f055a64903a';
```

You can find your values in:
- **Azure Portal → App registrations → your app → Overview** (for Client ID and Tenant ID)
- **Certificates & secrets** (for Client Secret)

Or alternatively, **re-save them in the Settings page** of your app — that calls the `manage-azure-config` edge function which should write to the `tenants` table. Maybe the initial save failed silently.

Either way, once those 3 fields are populated, the batch will start processing within 5 minutes (your token is already active right now, so it should go immediately!). 

Let me know once you've updated! 🚀
