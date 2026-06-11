-- Migration: Add resume columns to email_sends
-- Enables the auto-resume sweeper (see Email_Send_Auto_Resume_PRD.md)
-- to detect and recover rows stuck in status='processing'.
--
-- Three new columns:
--   retry_count            — incremented on every sweep; capped at 3 by the sweeper
--   last_error             — last recorded reason (e.g. 'abandoned by edge function')
--   processing_started_at  — set when send-individual inserts the row; the sweeper
--                            uses (now() - processing_started_at) > interval '10 minutes'
--                            to decide if a row is genuinely abandoned.
--
-- Backward compat: retry_count defaults to 0 so existing 3 rows are not affected.
-- The 2 currently-stuck 'processing' rows get processing_started_at = created_at
-- via the backfill UPDATE below, so the next sweeper run will recover them.

BEGIN;

ALTER TABLE public.email_sends
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz;

-- Backfill: for any existing 'processing' rows, set processing_started_at to
-- created_at. Without this, the new column would be NULL for pre-existing rows
-- and the sweeper would never pick them up (NULL > now() - 10 min is unknown).
UPDATE public.email_sends
   SET processing_started_at = created_at
 WHERE status = 'processing'
   AND processing_started_at IS NULL;

-- Partial index: optimiser for the sweeper's hot path
-- (finds stuck 'processing' rows older than 10 min without a full-table scan).
CREATE INDEX IF NOT EXISTS idx_email_sends_processing_age
  ON public.email_sends (processing_started_at)
  WHERE status = 'processing';

-- Partial index: optimiser for the retry-cap check in process-scheduled-individual
-- (finds scheduled rows that have been retried at least once).
CREATE INDEX IF NOT EXISTS idx_email_sends_retry_count
  ON public.email_sends (retry_count)
  WHERE retry_count > 0;

COMMIT;
