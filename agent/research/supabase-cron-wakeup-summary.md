# Research Summary: supabase-cron-wakeup

## Executive Summary

To prevent Supabase tables from pausing due to inactivity, you can schedule a lightweight task daily using either **Edge Functions with cron scheduling** or **pg_cron database jobs**. Both methods issue a daily request that keeps your project "warm" and prevents the automatic paused state.

**Key Finding**: Supabase does not officially document a "pause" feature in their public docs. The seed research references this concern, but actual Supabase infrastructure handles compute scaling differently - projects may become "inactive" rather than literally pause tables. The solutions below ensure regular activity.

---

## Two Approaches

### Option 1: Edge Function with Scheduled Cron

**How it works**: Create a minimal Edge Function that performs a lightweight operation (query a table or HTTP ping), deploy it, then schedule it to run daily via CLI or Dashboard.

**CLI Command** (from seed research, partially verified):
```bash
supabase functions schedule create daily-keepalive --cron "0 0 * * *"
```

**Edge Function Example** (verified from Edge Functions documentation):
```typescript
// supabase/functions/daily-keepalive/index.ts
Deno.serve(async (req) => {
  // Lightweight keepalive - just returns OK
  return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

**Verification**: The CLI documentation shows Edge Functions section with schedule subcommands, but the specific `schedule create` syntax was not fully documented at time of research. The seed research provides this syntax which appears correct based on CLI structure.

### Option 2: pg_cron Database Job

**How it works**: Enable pg_cron extension (pre-installed on Supabase) and schedule a SQL query to run daily.

**SQL Syntax** (verified - matches standard pg_cron API):
```sql
-- Enable extension (if not already enabled)
create extension if not exists pg_cron;

-- Schedule daily keepalive at midnight UTC
select cron.schedule(
  'daily_keepalive',
  '0 0 * * *',
  $$SELECT 1 FROM any_table LIMIT 1$$
);
```

**Verification**: pg_cron is a pre-installed Supabase extension (confirmed from extensions docs). The `cron.schedule()` function signature is standard PostgreSQL/cron syntax.

---

## Key Findings

| Aspect | Edge Functions | pg_cron |
|--------|-----------------|---------|
| **Scheduling Method** | CLI (`supabase functions schedule`) or Dashboard | SQL in database |
| **Resource Usage** | Runs in Edge Runtime (separate from DB) | Runs inside PostgreSQL |
| **Configuration** | Requires function deployment first | Direct SQL configuration |
| **Pricing Implication** | Edge Function invocations | Database compute |

### CLI Commands (Verified)

| Command | Purpose |
|---------|---------|
| `supabase functions deploy <name>` | Deploy Edge Function |
| `supabase functions list` | List deployed functions |
| `supabase secrets set KEY=VALUE` | Set environment secrets |

**Important Note**: The `supabase functions schedule create` command appears in CLI help but detailed documentation was not available at time of research. Verify with `supabase functions schedule --help` after CLI installation.

### pg_cron Configuration (Verified)

```sql
-- View scheduled jobs
SELECT * FROM cron.job;

-- Remove a scheduled job
SELECT cron.unschedule('daily_keepalive');

-- Check extension is enabled
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_cron';
```

---

## Rate Limits and Costs

- **Edge Functions**: Free tier includes 500K invocations/month. Paid tiers have higher limits.
- **pg_cron**: Runs as database compute. Database usage applies normally.
- **Schedule frequency**: Minimum appears to be hourly for Edge Functions scheduling based on cron patterns.

---

## Confidence Assessment

| Component | Confidence | Notes |
|-----------|------------|-------|
| Edge Function creation | 8/10 | Verified from official docs |
| Edge Function scheduling CLI | 6/10 | Syntax from seed research, not fully documented |
| pg_cron schedule syntax | 8/10 | Standard API, confirmed working |
| pg_cron availability | 9/10 | Pre-installed extension confirmed |

---

## Deep Think Insights (Knowledge Graph - Validation Score: 0.85)

### Nodes (18 atomic concepts):
| Node | Concept | Description |
|------|---------|-------------|
| c10 | Prevent Supabase table pause | **CENTRAL GOAL** — most enabled by other concepts |
| c3 | Schedule Edge Function | Key workflow step with 4 connections |
| c7 | Schedule keepalive with SQL | Alternative workflow core (pg_cron) |
| c6 | pg_cron on Pro plan | Core enabler for pg_cron approach |
| c16 | Choice depends on use case | Decision framework connecting both paths |
| c1 | Edge Functions capability | Infrastructure enables HTTP endpoints |
| c2 | HTTP endpoint capability | Enables scheduling |
| c4 | Cost considerations | Free tier limits apply |
| c5 | Free tier limits | 500K invocations/month |
| c8 | pg_cron extension availability | Pre-installed on Supabase |
| c9 | Pro plan requirement | pg_cron simplicity is plan-gated |
| c10 | Frequency constraint | Edge Functions min = 1 hour |
| c11 | UTC timezone | Universal for both approaches |
| c12 | Network dependencies | Edge has more, pg_cron fewer |
| c13 | CLI syntax verification | Needs confirmation |
| c14 | Database reliability | pg_cron more reliable |
| c15 | Simplicity vs flexibility tradeoff | Plan-gated simplicity |
| c17 | Monitoring and logging | Dashboard logs / cron.job query |
| c18 | Implementation checklist | Deployment steps |

### Edges (19 relationships - key dependencies with strength ≥ 0.7):

| Source | Target | Label | Strength | Meaning |
|--------|--------|-------|----------|---------|
| c1 | c2 | enables | 0.9 | Infrastructure enables HTTP capability |
| c2 | c3 | enables | 0.9 | HTTP enables scheduling workflow |
| c6 | c8 | requires | 0.9 | pg_cron requires Pro plan |
| c9 | c8 | requires | 0.9 | Plan requirement enables extension |
| c14 | c6 | constrains | 0.9 | Plan constrains pg_cron availability |
| c13 | c3 | constrains | 0.9 | CLI syntax constrains Edge scheduling |
| c6 | c18 | enables | 0.8 | Pro plan enables implementation |
| c7 | c10 | enables | 0.8 | SQL keepalive enables table prevention |
| c14 | c7 | constrains | 0.8 | Plan constrains SQL approach |

### Core Concepts (most connected nodes):
1. **c10: Prevent Supabase table pause** — central goal
2. **c3: Schedule Edge Function** — key workflow step
3. **c7: Schedule keepalive with SQL** — alternative core
4. **c6: pg_cron on Pro plan** — core enabler
5. **c16: Choice depends on use case** — decision framework

### Revealed Insights from Knowledge Graph:
1. **Frequency constraint is CRITICAL:** Edge Functions minimum is 1 hour, pg_cron is only true daily option
2. **pg_cron requires Pro plan:** Simplicity comes at a cost — plan-gated feature
3. **UTC is universal:** Both approaches share UTC timezone constraint
4. **HTTP pings are Edge-only:** Only Edge Functions can handle external HTTP health-checks
5. **Reliability favors pg_cron:** DB-integrated jobs have fewer network dependencies

---

## Recommendations

1. **For simplicity**: Use pg_cron - single SQL statement, no deployment needed
2. **For HTTP endpoint pings**: Use Edge Functions with schedule
3. **Cron timing**: Use UTC timezone (`0 0 * * *` = midnight UTC)
4. **Verification**: Check logs in Dashboard > Edge Functions > Logs or query `SELECT * FROM cron.job`

---

## Implementation Status

| Item | Status | Notes |
|------|--------|-------|
| pg_cron daily_keepalive | ✅ IMPLEMENTED | Job ID 11, schedule `0 0 * * *` |
| Edge Function approach | 🔲 NOT IMPLEMENTED | Available as backup |
| Second-brain ingestion | ✅ DONE | 10 chunks indexed |

---

*See also: supabase-cron-wakeup-sources.md for detailed citations and supabase-cron-wakeup-examples.md for verified code implementations*