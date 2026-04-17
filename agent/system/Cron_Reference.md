# Cron Jobs Reference

All cron jobs are managed in Supabase Dashboard → Database → pg_cron.
**Do NOT edit the `cron.job` table directly.** Use SQL migrations or Supabase Dashboard.

---

## Active Cron Jobs

| Job Name | Schedule | Function Called | Purpose |
|----------|----------|-----------------|---------|
| `cleanup-old-records` | `0 * * * *` | `SELECT cleanup_old_files()` | Hourly — deletes files >10 days old, cleans up email_sends/events older than 10 days. Files attached to active batches (pending/scheduled/processing) are protected. |
| `hardbounced-check` | `0 * * * *` | `net.http_post` → `maybe-hardbounced` | Hourly bounce check |
| `reset-daily-send-counts` | `0 0 * * *` | `SELECT reset_send_counts()` | Daily at midnight UTC |
| `reset-stuck-processing-locks` | `*/30 * * * *` | Raw SQL UPDATE | Every 30 mins — clears stale `processing` locks older than 2hrs |
| `process-email-batches-v2` | `*/5 * * * *` | `net.http_post` → `process-batches` | **Every 5 mins** — picks up pending/scheduled batches |
| `process-scheduled-individual` | `* * * * *` | `net.http_post` → `process-scheduled-individual` | **Every 1 min** — picks up scheduled single emails |

---

## How to Change a Schedule

pg_cron uses standard cron syntax: `minute hour day month weekday`

### Examples

| Schedule | Meaning |
|----------|---------|
| `* * * * *` | Every minute |
| `*/5 * * * *` | Every 5 minutes |
| `*/15 * * * *` | Every 15 minutes |
| `0 * * * *` | Every hour (at minute 0) |
| `0 0 * * *` | Daily at midnight UTC |
| `*/30 * * * *` | Every 30 minutes |
| `0 9 * * *` | Daily at 9:00 AM UTC |
| `0 9,18 * * *` | Daily at 9:00 AM and 6:00 PM UTC |

### Convert Local Time to UTC

This app is hosted on Supabase (servers run on **UTC**).

Example: You want `process-email-batches-v2` to run at **9:30 AM IST** and **9:30 PM IST**:
- IST = UTC + 5:30
- 9:30 AM IST = 4:00 AM UTC
- 9:30 PM IST = 4:00 PM UTC
- Schedule: `0 4,16 * * *`

---

## Changing a Schedule via SQL

### Change `process-email-batches-v2` from every 5 mins to every 10 mins

```sql
SELECT cron.alter_job(
  job_name := 'process-email-batches-v2',
  schedule := '*/10 * * * *'
);
```

### Change `process-scheduled-individual` from every 1 min to every 2 mins

```sql
SELECT cron.alter_job(
  job_name := 'process-scheduled-individual',
  schedule := '*/2 * * * *'
);
```

---

## Changing via Supabase Dashboard

1. Go to **Supabase Dashboard** → your project
2. Navigate to **Database** → **Extensions** → **pg_cron** (or **Database** → **Jobs** depending on UI version)
3. Find the job → click **Edit** or **Modify**
4. Change the schedule expression
5. Save

---

## Disable a Cron Job Temporarily

```sql
SELECT cron.disable('process-scheduled-individual');
```

Re-enable with:
```sql
SELECT cron.enable('process-scheduled-individual');
```

---

## Adding a New Cron Job

```sql
SELECT cron.schedule(
  'my-new-job',
  '* * * * *',  -- schedule
  $$
  SELECT my_function();
  $$
);
```

Or for calling an edge function:

```sql
SELECT cron.schedule(
  'my-new-job',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/my-function',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('service_role', true)
    ),
    body := '{}'::jsonb
  );
  $$
);
```

---

## Removing a Cron Job

```sql
SELECT cron.unschedule('my-new-job');
```

---

## Verifying Current Jobs

```sql
SELECT jobid, jobname, schedule, command, active FROM cron.job ORDER BY jobid;
```

---

## Cleanup Safeguard

`cleanup_old_files()` protects files referenced by active batches:

```sql
-- Files attached to these batch statuses are SKIPPED from cleanup:
WHERE status IN ('pending', 'scheduled', 'processing')
```

This means if a batch is scheduled far in the future, its attachments survive the 10-day cleanup. Only when the batch completes do its attachments become eligible for the next hourly cleanup run.

To change the retention period (currently 10 days):

```sql
-- Edit the function and change the interval:
cutoff_date TIMESTAMPTZ := NOW() - INTERVAL '10 days';
-- Change '10 days' to '7 days', '30 days', etc.
```

---

## Common Mistakes

- **Using `cron.job` INSERT instead of `cron.schedule`** — always use the stored procedure
- **Wrong timezone** — always write schedules in UTC, convert from local
- **Editing `cron.job` directly** — always use `cron.alter_job` or recreate
- **Schedule format** — five fields only: minute, hour, day, month, weekday. No seconds field.
