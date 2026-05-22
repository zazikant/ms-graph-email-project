# Seed Research Output: supabase-cron-wakeup

**Query:** how can i use Supabase cron or edge function to daily ping database or HTTP endpoint to prevent all tables pausing

**Date:** 2026-05-22

---

## Raw Script Output

```
OK - Imports
OK - Keys loaded
OK Schemas OK
OK Exceptions OK
OK Serper client defined
OK Browserless client defined
OK Reducers defined
OK NVIDIA gpt-oss-120b ready — test response: OK
OK ClassifierNode defined
OK SearchNode defined
OK BrowserNode defined
OK ReducerNodes defined
OK AggregatorNode defined
OK AnswerNode defined
OK Adversarial strategies and graph builder defined
OK Adversarial graph compiled

======================================================================
QUERY: how can i use Supabase cron or edge function to daily ping database or HTTP endpoint to prevent all tables pausing
INTENT: search

--- STRATEGY OUTPUTS ---

[QUICK]:
I'm sorry, but there are no snippets provided to reference for answering your question.

[DEEP]:
No pages fetched

[HYBRID]:
You can keep Supabase's "cold‑pause" from kicking in by scheduling a tiny Edge Function (or a pg‑cron job) that touches any table or hits an external URL once each day.  

1. **Edge Function route** – create a function (e.g. `daily‑keepalive`) that either runs a harmless query (`await supabase.from('my_table').select('id').limit(1)`) or calls `fetch('https://my‑service.com/heartbeat')`. Deploy it with `supabase functions deploy daily‑keepalive`.  

2. **Schedule it** – in the Supabase Dashboard go to **Edge Functions → Schedules** (or run `supabase functions schedule create daily‑keepalive --cron "0 0 * * *"` with the CLI) to set a daily cron expression (midnight UTC is typical).  

3. **Alternately, use pg‑cron** – enable the `pg_cron` extension (`create extension if not exists pg_cron;`) and add a job like `select cron.schedule('daily‑keepalive', '0 0 * * *', $$select 1 from my_table limit 1$$);`.  

Either method issues a lightweight request each day, preventing Supabase from automatically putting your tables into the paused state.

--- ADVERSARIAL JUDGE'S CRITIQUE ---
CRITIQUE:
Quick: Provides no useful information or guidance, making it irrelevant to the question.  
Deep: Returns an empty result, offering no content to address the query.  
Hybrid: Supplies a concise, practical solution with clear steps for both Edge Function scheduling and pg_cron, but could include more detail on setup, permissions, and troubleshooting.

--- FINAL SYNTHESIZED ANSWER ---
You can keep Supabase's automatic "cold‑pause" from stopping your tables by running a tiny task once a day that either queries a table or hits an external URL. There are two native ways to do this: an Edge Function with a schedule, or a pg_cron job inside the database.

**1. Edge Function approach**  
1. Create an Edge Function (e.g., `daily-keepalive`). Inside the function use the Supabase client or a simple fetch:  
   `await supabase.from('any_table').select('id').limit(1);`  // harmless read  
   or  
   `await fetch('https://example.com/heartbeat');`  // external ping  

2. Deploy the function:  
   `supabase functions deploy daily-keepalive`  

3. Add a schedule:  
   - In the Supabase Dashboard go to **Edge Functions → Schedules** and create a new schedule with the cron expression `0 0 * * *` (midnight UTC).  
   - Or from the CLI:  
     `supabase functions schedule create daily-keepalive --cron "0 0 * * *"`  

The function will run automatically each day, issuing a lightweight request that keeps the project "warm".

**2. pg_cron approach (database‑side)**  
1. Enable the pg_cron extension (requires a project on the Pro plan or higher):  
   `create extension if not exists pg_cron;`  

2. Schedule a simple query that touches a table:  
   `select cron.schedule('daily_keepalive', '0 0 * * *', $$select 1 from any_table limit 1$$);`  

   - The cron expression is the same as above (midnight UTC).  
   - The query can be as light as `select 1;` if you only need to keep the DB active, but selecting from a table guarantees the table is accessed.

**Choosing between the two**  
- **Edge Functions** are ideal if you also need to call an external service or prefer managing the schedule via the Supabase UI/CLI. They run in a separate container, so they don't consume DB resources.  
- **pg_cron** keeps everything inside PostgreSQL, which is simpler if you only need a DB query and already have the extension enabled.

**Additional tips**  
- Use UTC in the cron expression; Supabase schedules are evaluated in UTC.  
- Keep the task lightweight to avoid unnecessary compute costs.  
- Verify the schedule by checking the "Logs" tab for Edge Functions or querying `select * from cron.job;` for pg_cron.  
- If you have multiple projects, repeat the same setup for each one you want to keep warm.  

By implementing either a daily Edge Function schedule or a pg_cron job, you will reliably prevent all tables in your Supabase project from being paused due to inactivity.
======================================================================
```

---

## Strategy Responses Summary

| Strategy | Result |
|----------|--------|
| **Quick** | No useful output - search failed due to async context issue |
| **Deep** | No pages fetched - search failure cascaded |
| **Hybrid** | Full solution provided - 1050 chars covering Edge Functions and pg_cron |

---

## Adversarial Judge Critique

- **Quick:** Provides no useful information or guidance, making it irrelevant to the question.
- **Deep:** Returns an empty result, offering no content to address the query.
- **Hybrid:** Supplies a concise, practical solution with clear steps for both Edge Function scheduling and pg_cron, but could include more detail on setup, permissions, and troubleshooting.

---

## Final Synthesized Answer

Two approaches:

1. **Edge Function** - Create a function that does a lightweight table query or HTTP ping, deploy it, and schedule with cron `"0 0 * * *"` (midnight UTC) via dashboard or CLI.

2. **pg_cron** - Enable `pg_cron` extension and schedule: `select cron.schedule('daily_keepalive', '0 0 * * *', $$select 1 from any_table limit 1$$);`

Both methods issue a daily lightweight request to prevent Supabase's automatic paused state.