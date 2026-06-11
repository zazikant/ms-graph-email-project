-- Migration: Add retry_count to get_pending_batches() return
-- Required by the new 3-retry cap check in process-batches (deployed v24).
-- Without this, the worker sees retry_count=undefined → nullish coalesce to 0
-- → retry cap never triggers.
--
-- Backward compat: callers that destructure by name continue to work
-- (TypeScript destructures the object). Callers using positional access
-- (e.g. .status) will not be affected — the column is appended at the end.

BEGIN;

DROP FUNCTION IF EXISTS public.get_pending_batches();

CREATE OR REPLACE FUNCTION public.get_pending_batches()
RETURNS TABLE(
  batch_id uuid,
  user_id uuid,
  tenant_id uuid,
  subject text,
  content text,
  attachments jsonb,
  status text,
  total_count integer,
  sent_count integer,
  failed_count integer,
  retry_count integer
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  RETURN QUERY
  SELECT
    b.id AS batch_id, b.user_id, b.tenant_id, b.subject, b.content,
    b.attachments, b.status::text, b.total_count, b.sent_count, b.failed_count,
    b.retry_count
  FROM batches b
  WHERE
    (b.status = 'pending')
    OR (b.status = 'scheduled' AND b.scheduled_at IS NOT NULL AND b.scheduled_at <= now())
  ORDER BY b.created_at ASC;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.get_pending_batches() TO service_role;

COMMIT;
