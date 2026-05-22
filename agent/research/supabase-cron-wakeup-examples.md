# Code Examples: supabase-cron-wakeup

## Implementation Guide

This document contains verified code examples for implementing a daily keepalive ping to prevent Supabase project inactivity.

---

## Method 1: Edge Function with Scheduled Cron

### Step 1: Create the Edge Function

**[✅ VERIFIED]** Create a minimal Edge Function that performs a keepalive task.

```typescript
// supabase/functions/daily-keepalive/index.ts

Deno.serve(async (req) => {
  // Simple keepalive response
  // Can be extended to ping external URL or query database
  
  const response = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    message: 'Daily keepalive ping'
  }
  
  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

**Confidence**: 9/10
- **Source**: Supabase Edge Functions docs (official)
- **Source**: GitHub examples in supabase/supabase repository
- **Verification**: Standard Deno.serve pattern used in official examples

---

### Step 2: Deploy the Function

**[✅ VERIFIED]** CLI commands for deployment.

```bash
# Login to Supabase CLI
supabase login

# Link to your project
supabase link --project-ref your-project-ref

# Set any required secrets (if function uses external APIs)
supabase secrets set EXTERNAL_API_KEY=your-key

# Deploy the function
supabase functions deploy daily-keepalive
```

**Confidence**: 9/10
- **Source**: CLI docs and GitHub examples
- **Verification**: Standard workflow documented across sources

---

### Step 3: Schedule the Function (CLI)

**[⚠️ NEEDS VERIFICATION]** Schedule command syntax from seed research.

```bash
# Schedule daily at midnight UTC
supabase functions schedule create daily-keepalive --cron "0 0 * * *"

# Verify the schedule was created
supabase functions schedule list
```

**Confidence**: 6/10
- **Source**: Seed research (AI-generated)
- **Note**: CLI documentation shows schedule subcommands exist but specific syntax not fully documented
- **Action**: Verify with `supabase functions schedule --help`

Alternative dashboard method:
- Go to **Supabase Dashboard → Edge Functions → Schedules → New Schedule**
- Select your function and enter cron pattern `0 0 * * *`

---

### Step 4: HTTP Ping Variant (Optional)

**[✅ VERIFIED]** Edge Function that pings an external HTTP endpoint.

```typescript
// supabase/functions/http-keepalive/index.ts

Deno.serve(async (req) => {
  try {
    // Ping external service (example: your webhook endpoint)
    const response = await fetch('https://your-service.com/heartbeat', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    })
    
    const result = {
      status: response.ok ? 'ok' : 'failed',
      pinged: 'https://your-service.com/heartbeat',
      responseStatus: response.status,
      timestamp: new Date().toISOString()
    }
    
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({
      status: 'error',
      message: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
```

**Confidence**: 8/10
- **Source**: Supabase Edge Functions docs (fetch API available in Deno)
- **Source**: Edge Functions examples showing external API calls

---

## Method 2: pg_cron Database Job

### Step 1: Enable pg_cron Extension

**[✅ VERIFIED]** Enable via SQL (extension is pre-installed on Supabase).

```sql
-- Enable pg_cron extension (run in SQL Editor or via migration)
create extension if not exists pg_cron;

-- Verify it's enabled
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_cron';
```

**Confidence**: 9/10
- **Source**: Supabase extensions documentation (official)
- **Verification**: Standard PostgreSQL extension syntax

---

### Step 2: Schedule Daily Keepalive Query

**[✅ VERIFIED]** Schedule a lightweight SQL query.

```sql
-- Schedule daily keepalive at midnight UTC
-- Syntax: cron.schedule(job_name, cron_pattern, SQL_command)

SELECT cron.schedule(
  'daily_keepalive',      -- job name
  '0 0 * * *',           -- cron: midnight every day (UTC)
  $$SELECT 1$$            -- minimal query
);
```

**Alternative with table access** (ensures table is touched):

```sql
-- Schedule daily at midnight UTC, touches a specific table
SELECT cron.schedule(
  'daily_keepalive',
  '0 0 * * *',
  $$SELECT 1 FROM your_table_name LIMIT 1$$
);
```

**Confidence**: 8/10
- **Source**: Standard pg_cron API (widely documented PostgreSQL extension)
- **Source**: Seed research provided similar syntax
- **Verification**: Cron pattern `0 0 * * *` is standard cron syntax

---

### Step 3: Manage Scheduled Jobs

**[✅ VERIFIED]** View, modify, or remove scheduled jobs.

```sql
-- View all scheduled jobs
SELECT * FROM cron.job;

-- View job run history
SELECT * FROM cron.job_run_details;

-- Remove a scheduled job
SELECT cron.unschedule('daily_keepalive');

-- Disable a job temporarily (change active status)
UPDATE cron.job SET active = false WHERE jobname = 'daily_keepalive';
```

**Confidence**: 8/10
- **Source**: Standard pg_cron documentation

---

## Migration File Example

For version control, create a migration:

```sql
-- supabase/migrations/20260522000000_enable_keepalive_cron.sql

-- Enable pg_cron extension
create extension if not exists pg_cron;

-- Schedule daily keepalive at midnight UTC
-- Runs: SELECT 1 (minimal DB activity to keep project warm)
SELECT cron.schedule(
  'daily_keepalive',
  '0 0 * * *',
  $$SELECT 1$$
);
```

**Confidence**: 9/10
- **Source**: Standard Supabase migration workflow
- **Verification**: Combines verified extension enable + cron schedule syntax

---

## Implementation Reliability Guide

| Example | Confidence | Status |
|---------|------------|--------|
| Edge Function creation (basic) | 9/10 | ✅ VERIFIED |
| Edge Function HTTP ping | 8/10 | ✅ VERIFIED |
| Edge Function scheduling CLI | 6/10 | ⚠️ NEEDS VERIFICATION |
| pg_cron extension enable | 9/10 | ✅ VERIFIED |
| pg_cron schedule SQL | 8/10 | ✅ VERIFIED |
| Migration file | 9/10 | ✅ VERIFIED |

---

## Common Issues and Troubleshooting

### Edge Function Issues
- **Function not executing**: Check logs in Dashboard → Edge Functions → Logs
- **Schedule not working**: Verify project is linked (`supabase link`)

### pg_cron Issues
- **Jobs not running**: Ensure extension is enabled (`SELECT cron.schedule` works)
- **Permission errors**: Run with service_role or grant necessary permissions

---

## Cron Pattern Reference

| Pattern | Meaning |
|---------|---------|
| `0 0 * * *` | Midnight every day (UTC) |
| `0 12 * * *` | Noon every day (UTC) |
| `30 6 * * *` | 6:30 AM every day (UTC) |
| `0 * * * *` | Every hour |
| `*/15 * * * *` | Every 15 minutes |

**Note**: Supabase schedules are evaluated in UTC.

---

*See also: supabase-cron-wakeup-summary.md for recommendations and supabase-cron-wakeup-sources.md for full citation details*