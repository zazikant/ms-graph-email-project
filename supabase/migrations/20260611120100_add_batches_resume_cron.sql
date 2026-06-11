-- Migration: Auto-resume sweeper for stuck 'processing' batches
-- Mirrors migration 20260611110100 (auto_resume_email_sends). Closes the
-- gap where process-batches' in-function self-heal (L388, L785, L798) does
-- not run if the Edge Function hard-crashes before reaching those lines.
-- See Batches_Auto_Resume_PRD.md.
--
-- The sweeper:
--   1. Atomically claims stuck batches (FOR UPDATE SKIP LOCKED) so two
--      concurrent runs cannot double-reset the same batch.
--   2. Skips batches whose sent_by user's user_ms_graph_links.retry_after
--      is in the future (rate-limited — same courtesy as email_sends sweeper).
--   3. Increments retry_count and stamps last_error. Resets status to
--      'pending' and clears started_at so process-batches can pick it up
--      from the top.
--   4. Returns the count of batches reset (for monitoring + edge fn logs).
--
-- A 3-retry cap is enforced by process-batches (the next consumer in the
-- pipeline). The sweeper itself does not enforce the cap — it just resets
-- the batch to status='pending' so the existing worker will pick it up.
-- The cap check lives in the worker because that is where the actual send
-- attempt happens and where the per-attempt failure_reason is known.

BEGIN;

-- ─── Sweeper function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_resume_batches()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_reset_count integer := 0;
  v_max_retries int := 3;
BEGIN
  -- Atomically claim and reset stuck 'processing' batches.
  -- Using WITH ... FOR UPDATE SKIP LOCKED + UPDATE ... RETURNING so two
  -- concurrent sweeper invocations cannot both reset the same batch.
  WITH stuck AS (
    SELECT b.id
      FROM public.batches b
      JOIN public.user_ms_graph_links l ON l.user_id = b.sent_by
     WHERE b.status = 'processing'
       -- Older than 10 min (4× the 150s Edge Function ceiling + Graph latency)
       AND b.started_at < now() - interval '10 minutes'
       -- Skip users who are rate-limited (their retry_after is in the future)
       AND (l.retry_after IS NULL OR l.retry_after <= now())
       -- Only reset batches that are under the retry cap (defence-in-depth)
       AND b.retry_count < v_max_retries
     FOR UPDATE OF b SKIP LOCKED
  )
  UPDATE public.batches b
     SET status = 'pending',
         started_at = NULL,
         retry_count = b.retry_count + 1,
         last_error = 'abandoned by edge function'
    FROM stuck
   WHERE b.id = stuck.id;

  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  IF v_reset_count > 0 THEN
    RAISE LOG '[auto-resume-batches] Reset % stuck batch(es) from processing to pending', v_reset_count;
  END IF;

  RETURN v_reset_count;
END;
$function$;

-- Grant execute to service_role (the function is SECURITY DEFINER; only
-- service_role and postgres should ever invoke it).
REVOKE EXECUTE ON FUNCTION public.auto_resume_batches FROM public;
GRANT EXECUTE ON FUNCTION public.auto_resume_batches TO service_role;

-- ─── Cron schedule ───────────────────────────────────────────────────────────
-- Same cadence as auto-resume-email-sends (*/5). No conflict with any
-- existing cron: process-batches-v2 (jobid 9) is the worker, this is the
-- sweeper.
SELECT cron.schedule(
  'auto-resume-batches',
  '*/5 * * * *',
  $cron$SELECT public.auto_resume_batches();$cron$
);

-- ─── Stats view (for monitoring) ─────────────────────────────────────────────
CREATE OR REPLACE VIEW public.batches_stats AS
SELECT
  status,
  count(*)                                                          AS batch_count,
  max(COALESCE(started_at, created_at))                             AS last_activity,
  count(*) FILTER (WHERE status = 'processing'
                     AND started_at < now() - interval '10 minutes')
                                                                    AS stuck_over_10min,
  count(*) FILTER (WHERE retry_count > 0)                          AS retried_at_least_once,
  count(*) FILTER (WHERE status = 'failed'
                     AND last_error = 'max retries exceeded (3)')  AS failed_after_cap
FROM public.batches
GROUP BY status;

GRANT SELECT ON public.batches_stats TO service_role;

COMMIT;
