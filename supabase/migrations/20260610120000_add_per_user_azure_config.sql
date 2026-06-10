-- Migration: Add per-user Azure AD app configuration
-- This fixes the bug where all users in a Supabase tenant share ONE Azure app registration,
-- causing credential mixing when users belong to different Microsoft Entra ID directories
-- (e.g. gemengserv.com vs gem-engserv.net).
--
-- 3-tier lookup: per-user row -> per-tenant row (tenants table) -> env vars
-- The per-user row wins if set; otherwise falls back to tenant-level config (existing behavior).

BEGIN;

-- 1. Add per-user columns to user_ms_graph_links
ALTER TABLE public.user_ms_graph_links
  ADD COLUMN IF NOT EXISTS ms_client_id text,
  ADD COLUMN IF NOT EXISTS ms_client_secret text,
  ADD COLUMN IF NOT EXISTS ms_microsoft_tenant_id text,
  ADD COLUMN IF NOT EXISTS ms_authority_host text NOT NULL DEFAULT 'https://login.microsoftonline.com',
  ADD COLUMN IF NOT EXISTS azure_config_source text NOT NULL DEFAULT 'tenant_inherited';

-- 2. Add helpful index for membership lookups (no-op if already present)
CREATE INDEX IF NOT EXISTS idx_memberships_user_tenant
  ON public.memberships(user_id, tenant_id);

-- 3. Backfill gemengserv.com users: copy current tenant config to their user row
--    (so existing shashikant/gemengserv.com members don't lose their config)
UPDATE public.user_ms_graph_links l
SET
  ms_client_id = t.ms_client_id,
  ms_client_secret = t.ms_client_secret,
  ms_microsoft_tenant_id = t.ms_tenant_id,
  azure_config_source = 'tenant_inherited'
FROM public.memberships m
JOIN public.tenants t ON t.id = m.tenant_id
WHERE l.user_id = m.user_id
  AND l.ms_client_id IS NULL
  AND t.ms_client_id IS NOT NULL
  AND t.ms_client_secret IS NOT NULL
  AND t.ms_tenant_id IS NOT NULL
  AND m.user_id IN (
    SELECT id FROM auth.users
    WHERE email LIKE '%@gemengserv.com'
  );

-- 4. For gem-engserv.net users: do NOT pre-populate with gemengserv.com creds.
--    Their azure_config_source remains 'tenant_inherited' but the lookup will
--    skip the inherited tenant creds for these users because we will introduce
--    a per-user opt-in flag below. Admins can then call manage-azure-config
--    with target_user_id to set gem-engserv.net creds for those users.

-- 5. Helper view: per-user effective Azure config (user -> tenant -> null)
--    Used by the shared getOAuthConfig helper.
CREATE OR REPLACE VIEW public.v_user_azure_config AS
SELECT
  u.id AS user_id,
  u.email,
  t.id AS tenant_id,
  t.name AS tenant_name,
  -- Effective client_id: user override > tenant > null
  COALESCE(l.ms_client_id, t.ms_client_id) AS effective_client_id,
  -- Effective client_secret (user > tenant)
  COALESCE(l.ms_client_secret, t.ms_client_secret) AS effective_client_secret,
  -- Effective Microsoft tenant id (user > tenant)
  COALESCE(l.ms_microsoft_tenant_id, t.ms_tenant_id) AS effective_microsoft_tenant_id,
  -- Effective authority host (user > tenant > default)
  COALESCE(
    NULLIF(l.ms_authority_host, 'https://login.microsoftonline.com'),
    'https://login.microsoftonline.com'
  ) AS effective_authority_host,
  -- Where the config comes from
  CASE
    WHEN l.ms_client_id IS NOT NULL THEN 'user'
    WHEN t.ms_client_id IS NOT NULL THEN 'tenant'
    ELSE 'none'
  END AS source,
  l.azure_config_source AS user_config_status
FROM auth.users u
LEFT JOIN public.memberships m ON m.user_id = u.id
LEFT JOIN public.tenants t ON t.id = m.tenant_id
LEFT JOIN public.user_ms_graph_links l ON l.user_id = u.id;

GRANT SELECT ON public.v_user_azure_config TO service_role;

-- 6. RPC: store per-user Azure config (admin only; pass target_user_id to set on behalf of member)
CREATE OR REPLACE FUNCTION public.set_user_azure_config(
  p_requesting_user_id uuid,
  p_target_user_id uuid,
  p_client_id text,
  p_client_secret text,
  p_microsoft_tenant_id text,
  p_authority_host text DEFAULT 'https://login.microsoftonline.com'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_requesting_role text;
  v_target_tenant_id uuid;
  v_requesting_tenant_id uuid;
BEGIN
  -- Get requesting user's tenant + role
  SELECT tenant_id, role INTO v_requesting_tenant_id, v_requesting_role
  FROM memberships
  WHERE user_id = p_requesting_user_id
  LIMIT 1;

  IF v_requesting_role IS NULL OR v_requesting_role <> 'admin' THEN
    RAISE EXCEPTION 'Only admins can set Azure config' USING ERRCODE = '42501';
  END IF;

  -- Target user must be in the same Supabase tenant
  SELECT tenant_id INTO v_target_tenant_id
  FROM memberships
  WHERE user_id = p_target_user_id
  LIMIT 1;

  IF v_target_tenant_id IS NULL OR v_target_tenant_id <> v_requesting_tenant_id THEN
    RAISE EXCEPTION 'Target user is not in your tenant' USING ERRCODE = '42501';
  END IF;

  -- Validate GUIDs
  IF p_client_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid client_id format' USING ERRCODE = '22023';
  END IF;
  IF p_microsoft_tenant_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'Invalid microsoft_tenant_id format' USING ERRCODE = '22023';
  END IF;

  -- Upsert into user_ms_graph_links
  INSERT INTO public.user_ms_graph_links (
    user_id, ms_client_id, ms_client_secret, ms_microsoft_tenant_id,
    ms_authority_host, azure_config_source, status, updated_at
  )
  VALUES (
    p_target_user_id, p_client_id, p_client_secret, p_microsoft_tenant_id,
    p_authority_host, 'user_set', 'active', now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    ms_client_id = EXCLUDED.ms_client_id,
    ms_client_secret = EXCLUDED.ms_client_secret,
    ms_microsoft_tenant_id = EXCLUDED.ms_microsoft_tenant_id,
    ms_authority_host = EXCLUDED.ms_authority_host,
    azure_config_source = 'user_set',
    updated_at = now();

  RETURN jsonb_build_object(
    'success', true,
    'target_user_id', p_target_user_id,
    'source', 'user'
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.set_user_azure_config FROM public;
GRANT EXECUTE ON FUNCTION public.set_user_azure_config TO service_role;

-- 7. RPC: get effective Azure config for a given user (for debugging/UI)
CREATE OR REPLACE FUNCTION public.get_effective_azure_config(p_user_id uuid)
RETURNS TABLE(
  client_id text,
  client_secret_set boolean,
  microsoft_tenant_id text,
  authority_host text,
  source text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    v.effective_client_id,
    v.effective_client_secret IS NOT NULL AS client_secret_set,
    v.effective_microsoft_tenant_id,
    v.effective_authority_host,
    v.source
  FROM public.v_user_azure_config v
  WHERE v.user_id = p_user_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_effective_azure_config FROM public;
GRANT EXECUTE ON FUNCTION public.get_effective_azure_config TO service_role;

COMMIT;
