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
