-- Migration: Fix schedule_batch RPC to set batches.total_count
-- Root cause: the RPC inserts the batch with default total_count=0, then
-- inserts recipient_list rows, but never updates the batch's total_count
-- to reflect how many recipients were actually queued. Result: the Batches
-- tab UI shows "X/0 sent 0%" instead of "X/X sent 100%".
--
-- Fix: after the recipient_list INSERT, run an UPDATE to set
-- batches.total_count = (SELECT count(*) FROM recipient_list WHERE batch_id = v_batch_id).
-- Done in the same function body so the read-modify-write is atomic.
--
-- This file uses CREATE OR REPLACE; we do NOT change the function signature
-- so all existing callers (schedule-batch Edge Function, the 7-arg overload)
-- continue to work.

BEGIN;

CREATE OR REPLACE FUNCTION public.schedule_batch(
  p_user_id uuid,
  p_tenant_id uuid,
  p_list_id uuid,
  p_subject text,
  p_content text,
  p_attachments jsonb DEFAULT '[]'::jsonb,
  p_scheduled_at timestamp with time zone DEFAULT NULL::timestamp with time zone
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_batch_id uuid;
  v_status batch_status;
  v_now timestamptz := now();
BEGIN
  IF p_scheduled_at IS NOT NULL AND p_scheduled_at > v_now THEN
    v_status := 'scheduled'::batch_status;
  ELSE
    v_status := 'pending'::batch_status;
  END IF;

  INSERT INTO public.batches (
    tenant_id, sent_by, user_id, subject, content,
    attachments, status, scheduled_at, list_id
  )
  VALUES (
    p_tenant_id, p_user_id, p_user_id, p_subject, p_content,
    COALESCE(p_attachments, '[]'::jsonb),
    v_status, p_scheduled_at, p_list_id
  )
  RETURNING id INTO v_batch_id;

  INSERT INTO public.recipient_list (tenant_id, batch_id, email, status)
  SELECT p_tenant_id, v_batch_id, c.email, 'pending'::recipient_status
  FROM public.contacts c
  WHERE c.tenant_id = p_tenant_id
    AND c.status <> 'hardbounced'
    AND (
      (p_list_id IS NOT NULL AND c.list_id = p_list_id)
      OR
      (p_list_id IS NULL AND c.list_id IS NULL)
    );

  -- ─── FIX: backfill total_count with the actual number of recipients ───
  -- Without this, the Batches tab UI shows "X/0 sent 0%" for every batch.
  UPDATE public.batches
     SET total_count = (
       SELECT count(*)
         FROM public.recipient_list
        WHERE batch_id = v_batch_id
     )
   WHERE id = v_batch_id;

  RETURN v_batch_id;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.schedule_batch(uuid, uuid, uuid, text, text, jsonb, timestamp with time zone) TO service_role;

-- ─── Backfill existing affected batches ─────────────────────────────────────
-- For any batch where total_count=0 but recipient_list has rows, set
-- total_count = count of recipient_list rows. This is safe to run multiple
-- times (idempotent).
UPDATE public.batches b
   SET total_count = sub.cnt
  FROM (
    SELECT batch_id, count(*) AS cnt
      FROM public.recipient_list
     GROUP BY batch_id
  ) sub
 WHERE b.id = sub.batch_id
   AND (b.total_count IS NULL OR b.total_count = 0)
   AND sub.cnt > 0;

COMMIT;
