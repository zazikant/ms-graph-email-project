// supabase/functions/_shared/getOAuthConfig.ts
//
// Shared helper for resolving Microsoft Entra ID OAuth credentials.
//
// 3-tier lookup (first non-null wins):
//   1. Per-user row in user_ms_graph_links (ms_client_id / ms_client_secret / ms_microsoft_tenant_id)
//   2. Per-tenant row in tenants (ms_client_id / ms_client_secret / ms_tenant_id)
//   3. Environment variables (MS_CLIENT_ID / MS_CLIENT_SECRET / MS_TENANT_ID)
//
// The per-user row lets a single Supabase tenant host users from different
// Microsoft Entra ID directories (e.g. gemengserv.com vs gem-engserv.net)
// without one user's OAuth flow reusing another user's Azure app.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  tenantId: string
  authorityHost: string
  source: "user" | "tenant" | "environment" | "none"
}

/**
 * Resolve the OAuth configuration for a given user.
 *
 * @param supabase Service-role Supabase client.
 * @param userId   The auth.users.id of the user initiating the OAuth flow.
 */
export async function getOAuthConfig(
  supabase: SupabaseClient,
  userId: string
): Promise<OAuthConfig | null> {
  // Tier 1+2: per-user override, falling back to per-tenant.
  // We do this in a single RPC to keep the lookup atomic and to avoid
  // leaking secrets into the JS heap unnecessarily.
  const { data: row, error: rpcErr } = await supabase.rpc("get_effective_azure_config", {
    p_user_id: userId,
  })

  if (!rpcErr && row && row.length > 0 && row[0].client_id) {
    return {
      clientId: row[0].client_id,
      clientSecret: row[0].client_secret_set
        ? await fetchUserClientSecret(supabase, userId)
        : await fetchTenantClientSecret(supabase, userId),
      tenantId: row[0].microsoft_tenant_id,
      authorityHost: row[0].authority_host || "https://login.microsoftonline.com",
      source: row[0].source as "user" | "tenant",
    }
  }

  // Tier 3: environment variables (last-resort fallback for local dev / single-tenant deployments).
  const envClientId = Deno.env.get("MS_CLIENT_ID")
  const envClientSecret = Deno.env.get("MS_CLIENT_SECRET")
  const envTenantId = Deno.env.get("MS_TENANT_ID")
  if (envClientId && envClientSecret && envTenantId) {
    return {
      clientId: envClientId,
      clientSecret: envClientSecret,
      tenantId: envTenantId,
      authorityHost: Deno.env.get("MS_AUTHORITY_HOST") || "https://login.microsoftonline.com",
      source: "environment",
    }
  }

  return null
}

/**
 * Read the per-user client secret directly from user_ms_graph_links.
 * The RPC above returns only a `client_secret_set` boolean to minimise exposure.
 */
async function fetchUserClientSecret(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const { data } = await supabase
    .from("user_ms_graph_links")
    .select("ms_client_secret")
    .eq("user_id", userId)
    .maybeSingle()
  return data?.ms_client_secret ?? ""
}

/**
 * Read the per-tenant client secret directly from tenants.
 */
async function fetchTenantClientSecret(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const { data: membership } = await supabase
    .from("memberships")
    .select("tenant_id")
    .eq("user_id", userId)
    .maybeSingle()
  if (!membership?.tenant_id) return ""

  const { data: tenant } = await supabase
    .from("tenants")
    .select("ms_client_secret")
    .eq("id", membership.tenant_id)
    .maybeSingle()
  return tenant?.ms_client_secret ?? ""
}
