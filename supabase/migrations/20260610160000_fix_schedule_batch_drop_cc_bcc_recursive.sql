-- Migration: Fix schedule_batch 7-arg overload dropping the CC/BBC recursive call
-- The 7-arg schedule_batch overload's body still delegated to the (now-dropped) 9-arg overload
-- via `RETURN public.schedule_batch(p_user_id, ..., '{}', '{}')`, which broke once the 9-arg
-- overload was dropped. This replaces the overload's body with the actual logic.

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

  RETURN v_batch_id;
END;
$function$;
