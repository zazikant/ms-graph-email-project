# Interesting Aspect

Smart Batch Processing - For the method only deploying mails using token that is not via Azure AD. When token gets expired, the batch stops sending emails and gets in "pending" mode. But, As the token is pasted.. The mails are resumed "processing" in about 5-10 minutes. 


# Azure AD steps

The flow for a new tenant:
New user signs up → creates a new tenant in the tenants table (empty Azure AD fields)
They go to Settings tab → follow the same 7-step guide you did:
  Register an Azure AD app in their company's Azure portal
  Get their own client_id, client_secret, tenant_id
  Save it via the Settings page (stored in their tenants row)
They click "Connect with Microsoft" → OAuth flow uses their Azure AD app credentials
Token stored in their user_ms_graph_links row → tied to their user_id

| What | Where stored | Scope |
|------|-------------|-------|
| Azure AD credentials (`ms_client_id`, `ms_client_secret`, `ms_tenant_id`) | `tenants` table → **per tenant** | Each company has its own row |
| OAuth tokens (access + refresh) | `user_ms_graph_links` table → **per user** | Each user has their own row |
| Contacts, lists, files | All filtered by `tenant_id` | Complete data isolation |
| Email sends | All filtered by `tenant_id` | Complete data isolation |

The edge functions dynamically fetch credentials using tenant.ms_client_id, tenant.ms_client_secret, tenant.ms_tenant_id from the current user's tenant — never hardcoded. So Company A (gem-engserv.net) and Company B (acme.com) each use their own Azure AD app, their own tokens, and their own data. Completely isolated! 🏢✅

