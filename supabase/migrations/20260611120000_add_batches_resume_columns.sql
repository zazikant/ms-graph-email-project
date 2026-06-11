-- Migration: Add resume columns to batches
-- Mirrors migration 20260611110000 (email_sends). Enables the auto-resume
-- sweeper (see Batches_Auto_Resume_PRD.md) to detect and recover rows
-- stuck in status='processing'.
--
-- The batches table already has `started_at timestamptz` (set when the
-- batch is first picked up by process-batches at L408). The sweeper uses
-- `started_at` as the stuck-detection column instead of adding a new
-- `processing_started_at` — clean reuse, no schema bloat.
--
-- Two new columns:
--   retry_count  -- incremented on every sweep; capped at 3 by the sweeper
--   last_error   -- last recorded reason (e.g. 'abandoned by edge function')
--
-- Backward compat: retry_count defaults to 0 so existing batches are not
-- affected. The 0 currently-stuck 'processing' rows need no backfill
-- (started_at was already set on transition to 'processing' by
-- process-batches L408).

BEGIN;

ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text;

-- Partial index: optimiser for the sweeper's hot path
-- (finds stuck 'processing' batches older than 10 min without a full-table scan).
CREATE INDEX IF NOT EXISTS idx_batches_processing_age
  ON public.batches (started_at)
  WHERE status = 'processing';

-- Partial index: optimiser for the retry-cap check in process-batches
-- (finds pending batches that have been retried at least once).
CREATE INDEX IF NOT EXISTS idx_batches_retry_count
  ON public.batches (retry_count)
  WHERE retry_count > 0;

COMMIT;
