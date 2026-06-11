# Credential Expiry Reminder

**Generated:** 2026-06-11
**Source:** User-reported (`business@gem-engserv.net` said "certificate for this azure ad is expriring in 2 years")

## Affected Azure AD Apps

| App | Client ID | Microsoft Entra Tenant ID | Type | Approx. Expiry | Reminder Date (60 days prior) |
|---|---|---|---|---|---|
| **gem-engserv.net** (per-user override for `business@gem-engserv.net`) | `3541a59f-8159-4b09-ad63-a60bcab03ec9` | `3780d0ca-6921-4bcd-83a9-b8a47bf74088` | Confidential client (has `ms_client_secret`) | ~2028-06-11 (user said "2 years") | **2028-04-12** |
| **gemengserv.com** (tenant default) | `fbcc0398-1802-4909-88bf-96ec38c6cf3f` | `7c52c74e-1933-4e68-a4b7-2719ced4c7c2` | Confidential client (has `ms_client_secret`) | unknown | unknown |

## Storage Locations

The credentials are stored in two places, both via the `supabase/functions/manage-azure-config` edge function:

1. **Per-user (overrides tenant):** `user_ms_graph_links.ms_client_id`, `ms_client_secret`, `ms_microsoft_tenant_id`
   - Currently set for `business@gem-engserv.net` and `jaideep.singh@gem-engserv.net` (azure_config_source='user_set').
2. **Per-tenant (fallback):** `tenants.ms_client_id`, `ms_client_secret`, `ms_tenant_id`
   - Currently set for tenant `d15bd162-02e7-4854-bfec-5f055a64903a` ("shashikant.zarekar@gemengserv.com's Organization").

## How to Check Current Expiry

1. Go to https://portal.azure.com
2. **App registrations** → select the app
3. **Certificates & secrets** → **Client secrets** tab
4. The **Expires** column shows the date

## How to Renew (before expiry)

1. In the same **Certificates & secrets** tab, click **+ New client secret**
2. Set **Expires** to **24 months** (maximum)
3. Copy the **Value** immediately (it is hidden after you leave the page)
4. Update the value in **both** the Azure portal AND the Supabase DB:
   - In the app: Settings tab → Azure AD App Configuration → paste new secret
   - Or via SQL: `UPDATE user_ms_graph_links SET ms_client_secret = '<new>' WHERE user_id = '<uuid>';` (or `UPDATE tenants SET ms_client_secret = '<new>' WHERE id = '<uuid>';`)
5. Trigger a manual token refresh by re-connecting Microsoft in the app
6. The 90-day refresh_token cycle restarts after re-consent

## What Happens If It Expires

- `tryRefreshToken` POSTs to `https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token` with `grant_type=refresh_token`
- Microsoft returns `{"error": "invalid_client", "error_description": "..."}` (HTTP 401)
- The helper's `invalid_grant` branch DOES NOT fire (it only fires for `invalid_grant`), so the lock is **released and status returns to `token_expired`** (the helper falls through to the generic `unknown` reason)
- The user sees **403** in the app
- The user must manually re-authorize via the **Connect with Microsoft** button
- **All send/batch operations stop for affected users** until renewal

## Reminder Setup

The user mentioned "2 years" for the gem-engserv.net app. The recommended calendar reminder:

- **Date:** 2028-04-12 (60 days before 2028-06-11)
- **Action:** Renew `ms_client_secret` for Azure AD app `3541a59f-8159-4b09-ad63-a60bcab03ec9`
- **Where:** Azure Portal → App registrations → [this app] → Certificates & secrets

The gemengserv.com app's expiry is unknown — check it during the next maintenance window.

## Related

- SOP: `agent/sops/mistake-2026-06-11-token-refresh-gap.md`
- PRD: `agent/task/Token_Auto_Refresh_Fix_PRD.md`
- Edge function: `supabase/functions/manage-azure-config/index.ts`
- DB column: `user_ms_graph_links.ms_client_secret`, `tenants.ms_client_secret`
- Per-user config source column: `user_ms_graph_links.azure_config_source` (`'user_set'` means per-user, `'tenant_inherited'` means falls back to tenant)
