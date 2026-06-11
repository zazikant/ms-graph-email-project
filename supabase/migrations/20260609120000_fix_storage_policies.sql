-- Fix: Add storage RLS policies for the dfsdfsdf bucket
-- Without these, users cannot delete files even with correct paths

-- Allow authenticated users to INSERT (upload) files to their tenant folder
CREATE POLICY "Users can upload files to their tenant folder"
ON storage.objects
FOR INSERT
TO public
WITH CHECK (
  bucket_id = 'dfsdfsdf'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM memberships WHERE user_id = auth.uid()
  )
);

-- Allow authenticated users to SELECT (list/read) files in their tenant folder
CREATE POLICY "Users can read files in their tenant folder"
ON storage.objects
FOR SELECT
TO public
USING (
  bucket_id = 'dfsdfsdf'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM memberships WHERE user_id = auth.uid()
  )
);

-- Allow authenticated users to DELETE files in their tenant folder
CREATE POLICY "Users can delete files in their tenant folder"
ON storage.objects
FOR DELETE
TO public
USING (
  bucket_id = 'dfsdfsdf'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM memberships WHERE user_id = auth.uid()
  )
);

-- Allow authenticated users to UPDATE files in their tenant folder
CREATE POLICY "Users can update files in their tenant folder"
ON storage.objects
FOR UPDATE
TO public
USING (
  bucket_id = 'dfsdfsdf'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM memberships WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  bucket_id = 'dfsdfsdf'
  AND auth.uid() IS NOT NULL
  AND (storage.foldername(name))[1] IN (
    SELECT tenant_id::text FROM memberships WHERE user_id = auth.uid()
  )
);
