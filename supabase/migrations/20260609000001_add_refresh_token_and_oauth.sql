-- Migration: Add refresh_token column and OAuth support fields
-- This enables automatic token refresh during batch processing,
-- eliminating the "batch stuck as token expired" issue.

-- 1. Add refresh_token column to user_ms_graph_links
ALTER TABLE public.user_ms_graph_links
ADD COLUMN IF NOT EXISTS refresh_token text;

-- 2. Add code_verifier column for PKCE flow (temporary storage during OAuth)
ALTER TABLE public.user_ms_graph_links
ADD COLUMN IF NOT EXISTS code_verifier text;

-- 3. Ensure expires_at column exists (may already exist)
ALTER TABLE public.user_ms_graph_links
ADD COLUMN IF NOT EXISTS expires_at timestamptz;

-- 4. Update the store_ms_graph_access_token RPC to also accept refresh_token and expires_at
CREATE OR REPLACE FUNCTION public.store_ms_graph_access_token(
  p_user_id uuid,
  p_access_token text,
  p_refresh_token text DEFAULT NULL,
  p_expires_at timestamptz DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_secret_id uuid;
BEGIN
  -- Upsert into user_ms_graph_links
  INSERT INTO public.user_ms_graph_links (user_id, access_token, refresh_token, expires_at, status, updated_at)
  VALUES (
    p_user_id,
    p_access_token,
    p_refresh_token,
    p_expires_at,
    'active',
    now()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    access_token = p_access_token,
    refresh_token = COALESCE(p_refresh_token, user_ms_graph_links.refresh_token),
    expires_at = COALESCE(p_expires_at, user_ms_graph_links.expires_at),
    status = 'active',
    processing_since = NULL,
    retry_after = NULL,
    updated_at = now();
END;
$function$;

-- 5. Restrict execution to service_role only
REVOKE EXECUTE ON FUNCTION public.store_ms_graph_access_token FROM public;
GRANT EXECUTE ON FUNCTION public.store_ms_graph_access_token TO service_role;

-- 6. Update get_token_status to include new fields
CREATE OR REPLACE FUNCTION public.get_token_status(p_user_id uuid)
RETURNS TABLE(
  token_exists boolean,
  status text,
  retry_after timestamptz,
  send_count integer,
  expires_at timestamptz,
  has_refresh_token boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    l.access_token IS NOT NULL AS token_exists,
    l.status,
    l.retry_after,
    l.send_count,
    l.expires_at,
    l.refresh_token IS NOT NULL AS has_refresh_token
  FROM public.user_ms_graph_links l
  WHERE l.user_id = p_user_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_token_status FROM public;
GRANT EXECUTE ON FUNCTION public.get_token_status TO service_role;

-- 7. Update the batches status check constraint to include 'paused'
-- (for future use — batches paused on token expiry instead of failed)
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_status_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_status_check
  CHECK (status IN ('pending', 'scheduled', 'processing', 'completed', 'paused', 'failed'));

-- 8. Fix any currently stuck batches: set failed batches with remaining pending recipients back to pending
-- This recovers batches that were incorrectly marked as failed due to token expiry
UPDATE public.batches
SET status = 'pending'
WHERE status = 'failed'
  AND id IN (
    SELECT b.id
    FROM public.batches b
    WHERE b.status = 'failed'
      AND EXISTS (
        SELECT 1 FROM public.recipient_list rl
        WHERE rl.batch_id = b.id AND rl.status = 'pending'
      )
  );
