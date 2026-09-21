-- Migration: Add pg_cron audit log retention (cleanup-cron-run-details)
--
-- Background:
--   pg_cron writes one row to cron.job_run_details for every single job
--   execution. With 9 active jobs (incl. process-scheduled-individual which
--   runs every minute), this table accumulates ~2,500 rows/day. Over months
--   with no retention, it grows unbounded — on this project it reached
--   335,756 rows / 160 MB before this migration was written.
--
--   Nothing in the application codebase reads cron.job_run_details. It is
--   pure pg_cron internal audit log (run timestamps, status, return codes).
--   pg_cron itself only appends; it never reads the table back. Safe to
--   purge aggressively.
--
-- This migration:
--   1. Unschedules any pre-existing job with the same name (idempotent —
--      safe to re-run, safe on DBs where the job was scheduled manually).
--   2. Schedules a daily cleanup at 03:00 UTC that deletes rows older
--      than 2 days.
--
-- Retention is set to 2 days: enough to debug "why didn't job X run
-- yesterday?" without growing disk usage materially (~5k rows max).

BEGIN;

-- ─── Idempotent unschedule (ignore "job not found") ──────────────────────────
DO $$
BEGIN
  PERFORM cron.unschedule('cleanup-cron-run-details');
EXCEPTION WHEN OTHERS THEN
  -- Job doesn't exist yet — expected on fresh DBs. Swallow.
  NULL;
END
$$;

-- ─── Schedule daily purge at 03:00 UTC ───────────────────────────────────────
SELECT cron.schedule(
  'cleanup-cron-run-details',
  '0 3 * * *',
  $cron$
    DELETE FROM cron.job_run_details
    WHERE start_time < now() - interval '2 days';
  $cron$
);

COMMIT;
