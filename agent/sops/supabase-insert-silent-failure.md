# Bug: Wrong Column Name in Supabase INSERT Silently Failed

## Date: 2026-04-17

## Severity: High

## What Happened

The `send-individual` edge function used `file_path` as the column name when inserting into `send_attachments`, but the actual column name is `storage_path`. Supabase does NOT throw an error for unknown columns in INSERTs — it silently ignores them. This caused attachment records to never be created, even though emails were sent successfully with attachments.

## Why It Was Hard to Find

1. No error was thrown — Supabase client accepted the INSERT without complaint
2. The `email_sends.attachments` JSONB column was populated correctly, making it seem like attachments were recorded
3. The `send_attachments` table remained empty, but there was no obvious indication of why
4. MCP direct SQL inserts worked fine, proving the table/RLS was correct

## Root Cause

Column name mismatch: `file_path` (used in code) vs `storage_path` (actual column)

## Lesson Learned

**Always verify column names match between code and database schema.** When using Supabase:

1. Query `information_schema.columns` to get exact column names before writing INSERT code
2. Add explicit error logging around all database inserts: `if (error) console.error(...)`
3. Never assume a column name — always check the actual schema
4. Supabase js client silently ignores unknown columns in INSERTs (doesn't throw)

## Prevention

- [ ] Add INSERT error logging to all edge functions
- [ ] Verify column names against `information_schema.columns` before INSERTs
- [ ] Consider using TypeScript types generated from DB schema

## Related Files

- `supabase/functions/send-individual/index.ts` — fixed
- `supabase/functions/process-scheduled-individual/index.ts` — already correct
- `supabase/functions/process-batches/index.ts` — already correct
