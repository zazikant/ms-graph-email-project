-- Migration: Auto-resume sweeper for stuck 'processing' email_sends rows
-- Mirrors the proven process-batches self-heal pattern (which reverts batches
-- to status='pending' on token_expired/429/timeout). See Email_Send_Auto_Resume_PRD.md.
--
-- The sweeper:
--   1. Atomically claims stuck rows (FOR UPDATE SKIP LOCKED) so two concurrent
--      runs cannot double-reset the same row.
--   2. Skips users whose user_ms_graph_links.retry_after is in the future
--      (rate-limited -- same courtesy as process-batches).
--   3. Increments retry_count and stamps last_error / send_at = now().
--   4. Returns the count of rows reset (for monitoring + edge fn logs).
--
-- A 3-retry cap is enforced by process-scheduled-individual (the next consumer
-- in the pipeline). The sweeper itself does not enforce the cap -- it just resets
-- the row to status='scheduled' so the existing worker will pick it up.
-- The cap check lives in the worker because that is where the actual send attempt
-- happens and where the per-attempt failure_reason is known.

BEGIN;

-- ─── Sweeper function ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.auto_resume_email_sends()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_reset_count integer := 0;
  v_max_retries int := 3;
BEGIN
  -- Atomically claim and reset stuck 'processing' rows.
  -- Using WITH ... FOR UPDATE SKIP LOCKED + UPDATE ... RETURNING so two
  -- concurrent sweeper invocations cannot both reset the same row.
  WITH stuck AS (
    SELECT es.id
      FROM public.email_sends es
      JOIN public.user_ms_graph_links l ON l.user_id = es.user_id
     WHERE es.status = 'processing'
       -- Older than 10 min (4× the 150s Edge Function ceiling + Graph latency)
       AND es.processing_started_at < now() - interval '10 minutes'
       -- Skip users who are rate-limited (their retry_after is in the future)
       AND (l.retry_after IS NULL OR l.retry_after <= now())
       -- Only reset rows that are under the retry cap (defence-in-depth -- the
       -- worker enforces the cap authoritatively, but this avoids pointless
       -- resets that the worker will immediately mark failed anyway)
       AND es.retry_count < v_max_retries
     FOR UPDATE OF es SKIP LOCKED
  )
  UPDATE public.email_sends es
     SET status = 'scheduled',
         send_at = now(),
         retry_count = es.retry_count + 1,
         last_error = 'abandoned by edge function',
         updated_at = now()
    FROM stuck
   WHERE es.id = stuck.id;

  GET DIAGNOSTICS v_reset_count = ROW_COUNT;

  IF v_reset_count > 0 THEN
    RAISE LOG '[auto-resume-email-sends] Reset % stuck email_sends row(s) from processing to scheduled', v_reset_count;
  END IF;

  RETURN v_reset_count;
END;
$function$;

-- Grant execute to service_role (the function is SECURITY DEFINER; only
-- service_role and postgres should ever invoke it).
REVOKE EXECUTE ON FUNCTION public.auto_resume_email_sends FROM public;
GRANT EXECUTE ON FUNCTION public.auto_resume_email_sends TO service_role;

-- ─── Cron schedule ───────────────────────────────────────────────────────────
-- Same cadence as process-batches (*/5). Skipped: existing crons (clean-up
-- old files, hardbounced-check, reset-daily-send-counts, reset-stuck-
-- processing-locks, process-email-batches-v2, process-scheduled-individual,
-- daily_keepalive) -- none of them overlap with this sweeper's responsibility.
SELECT cron.schedule(
  'auto-resume-email-sends',
  '*/5 * * * *',
  $cron$SELECT public.auto_resume_email_sends();$cron$
);

-- ─── Stats view (for monitoring) ─────────────────────────────────────────────
CREATE OR REPLACE VIEW public.email_sends_stats AS
SELECT
  status,
  count(*)                                                          AS row_count,
  max(updated_at)                                                   AS last_updated,
  count(*) FILTER (WHERE status = 'processing'
                     AND processing_started_at < now() - interval '10 minutes')
                                                                    AS stuck_over_10min,
  count(*) FILTER (WHERE retry_count > 0)                          AS retried_at_least_once,
  count(*) FILTER (WHERE status = 'failed'
                     AND last_error = 'max retries exceeded (3)')  AS failed_after_cap
FROM public.email_sends
GROUP BY status;

GRANT SELECT ON public.email_sends_stats TO service_role;

COMMIT;
