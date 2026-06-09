# Agent Session

## Date: 2026-04-17

## Task: Fix email attachments not showing in History tab

## Problem
User reported that attachments work for immediate individual emails (sent via Microsoft Graph) but don't show up in the History tab's attachment column.

## Root Cause

**`send-individual` edge function used wrong column name in `send_attachments` INSERT**

File: `supabase/functions/send-individual/index.ts` (line ~305)
- Used `file_path: a.path` instead of `storage_path: a.path`
- Supabase silently ignores unknown columns in INSERTs — no error thrown, but row never created
- The `send_attachments` table's actual column name is `storage_path`

## Fix Applied

**File: `send-individual/index.ts`**

Changed:
```typescript
// BEFORE (wrong column name)
const attRows = attachments.map((a: { name: string; path: string; size: number }) => ({
  send_id: sendId,
  file_name: a.name,
  file_path: a.path,    // ❌ WRONG — no such column
  file_size: a.size
}))

// AFTER (correct column name)
const attRows = attachments.map((a: { name: string; path: string; size: number }) => ({
  send_id: sendId,
  file_name: a.name,
  storage_path: a.path,  // ✅ CORRECT
  file_size: a.size
}))
const { error: attError } = await supabase.from('send_attachments').insert(attRows)
if (attError) console.error('send_attachments insert error:', attError)
```

## Database Changes

1. `email_sends.attachments` column — already existed (jsonb)
2. `send_attachments` RLS INSERT policy — created to allow service role inserts
3. `send_attachments.storage_path` — actual column name (NOT `file_path`)

## Verification

- Test email sent with attachment: "ATTACHMENT FIX VERIFICATION TEST"
- History tab now shows: `1776167126537-email-history.csv` in attachment column
- DB query confirms: `send_attachments` row created with correct `storage_path`

## Other Edge Functions (Already Correct)

- `process-scheduled-individual` — uses `storage_path` correctly (line 280)
- `process-batches` — uses `storage_path` correctly (line 369)

## Files Changed

- `D:\test\ms-graph-email-project\supabase\functions\send-individual\index.ts`

## Status: COMPLETED ✅
