-- Add DELETE policies for email_sends, email_events, send_attachments
-- Fixes issue where delete appeared to succeed but records reappeared

-- email_sends DELETE policy
CREATE POLICY "Users can delete their own tenant sends"
ON email_sends
FOR DELETE
TO public
USING (tenant_id IN (
  SELECT tenant_id FROM memberships WHERE user_id = auth.uid()
));

-- email_events DELETE policy
CREATE POLICY "Users can delete their own tenant email events"
ON email_events
FOR DELETE
TO public
USING (
  send_id IN (
    SELECT id FROM email_sends
    WHERE tenant_id IN (
      SELECT tenant_id FROM memberships WHERE user_id = auth.uid()
    )
  )
);

-- send_attachments DELETE policy
CREATE POLICY "Users can delete their own tenant send attachments"
ON send_attachments
FOR DELETE
TO public
USING (
  send_id IN (
    SELECT id FROM email_sends
    WHERE tenant_id IN (
      SELECT tenant_id FROM memberships WHERE user_id = auth.uid()
    )
  )
);

-- Updated cleanup_old_files() function to delete ALL files from storage older than 10 days
-- This includes files uploaded via Compose mail, Files tab, or anywhere
CREATE OR REPLACE FUNCTION public.cleanup_old_files()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
  cutoff_date TIMESTAMPTZ := NOW() - INTERVAL '10 days';
  storage_deleted_count INTEGER := 0;
BEGIN
  -- Delete ALL files from storage that are older than 10 days
  -- This applies to all files regardless of whether they were attached to emails
  
  DELETE FROM storage.objects
  WHERE bucket_id = 'dfsdfsdf'
  AND created_at < cutoff_date;
  
  GET DIAGNOSTICS storage_deleted_count = ROW_COUNT;
  RAISE NOTICE 'Deleted % files from storage', storage_deleted_count;

  -- Clean up send_attachments where parent email_sends is older than 10 days
  DELETE FROM send_attachments 
  WHERE send_id IN (
    SELECT id FROM email_sends 
    WHERE created_at < cutoff_date
  );
  
  -- Delete email_events older than 10 days
  DELETE FROM email_events 
  WHERE send_id IN (
    SELECT id FROM email_sends 
    WHERE created_at < cutoff_date
  );
  
  -- Delete email_sends older than 10 days
  DELETE FROM email_sends 
  WHERE created_at < cutoff_date;

  RAISE NOTICE 'Cleaned up records older than %', cutoff_date;
END;
$function$