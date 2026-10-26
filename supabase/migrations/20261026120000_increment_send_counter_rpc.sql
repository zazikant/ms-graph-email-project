-- Atomic per-send open/click counter increment.
--
-- WHY: both tracking edge functions previously did a read-modify-write
-- (`select open_count` ... `update open_count = old + 1`). When a corporate
-- mail scanner fires several open/click requests within milliseconds (we
-- measured 3 clicks in 75ms), two concurrent requests read the same value
-- and one increment is lost. Production audit (2026-10-26): 112 of 120
-- sampled sends had click_count lower than the actual number of click
-- events in email_events.
--
-- A single UPDATE statement re-reads the row under its row lock, so
-- concurrent calls can no longer lose increments. SECURITY DEFINER so the
-- service-role key used by the edge functions needs no table grants beyond
-- what it already has.

CREATE OR REPLACE FUNCTION public.increment_send_counter(
  p_send_id uuid,
  p_event_type text
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.email_sends
  SET open_count  = CASE WHEN p_event_type = 'open'  THEN COALESCE(open_count, 0) + 1 ELSE open_count  END,
      click_count = CASE WHEN p_event_type = 'click' THEN COALESCE(click_count, 0) + 1 ELSE click_count END
  WHERE id = p_send_id;
$$;

GRANT EXECUTE ON FUNCTION public.increment_send_counter(uuid, text) TO service_role;
