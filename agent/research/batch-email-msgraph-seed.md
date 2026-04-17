# Microsoft Graph Batch Email Sending - Research Seed

## Original Query
best practices for batch email sending with Microsoft Graph API, rate limiting, batching strategies, parallel vs sequential sending, batch endpoint vs individual requests, reliability patterns

===========================================================================
QUERY: best practices for batch email sending with Microsoft Graph API, rate limiting, batching strategies, parallel vs sequential sending, batch endpoint vs individual requests, reliability patterns

INTENT: search

--- STRATEGY OUTPUTS ---

[QUICK]:
Use the Graph batch endpoint to group many sendMail calls into a single request, keeping the number of HTTP calls low while respecting the service's throttling limits. Limit concurrency to no more than four simultaneous requests per mailbox (e.g., via a per‑mailbox queue or semaphore) and prefer sequential processing inside each batch, falling back to individual requests only when a batch fails and retrying with exponential back‑off. This approach balances performance, avoids throttling, and improves reliability for bulk email delivery.

[DEEP]:
When sending large volumes of email with Microsoft Graph, keep the per‑mailbox throttling limits in mind — each mailbox allows 4 concurrent PUT/POST/PATCH calls and a total of 150 MB of payload (≈ 30 large messages) within any 5‑minute window, and an app‑plus‑mailbox can issue only 10 000 requests per 10 minutes. The most efficient way to stay under those caps is to use the /v1.0/$batch endpoint, which collapses up to 20 individual sendMail requests into a single HTTP call; however, every sub‑request in the batch is still evaluated against the same mailbox limits, so a batch that contains more than 4 simultaneous sends to the same mailbox will be throttled even though the batch itself returns 200. To maximise throughput, schedule parallel batches only after you have partitioned the target mailboxes and limited the number of concurrent sends per mailbox to ≤ 4, and use sequential processing (or a small worker pool) for messages destined for the same mailbox. On receiving a 429 Too Many Requests response, honor the Retry‑After header (or fall back to exponential back‑off) and retry idempotently; also cache the Message‑Id you generated so you can safely replay failed sends without creating duplicates. Finally, complement the batch strategy with delta queries or change notifications to avoid polling, and consider Microsoft Graph Data Connect for bulk extract‑or‑send scenarios where the per‑mailbox write limits become a hard blocker.

[HYBRID]:
When sending large volumes of email with Microsoft Graph, group up to 20 send‑mail calls into a single $batch request to cut network round‑trips, but never exceed the per‑mailbox throttling limits (≈150 MB of PUT/POST/PATCH data and ≤ 4 concurrent requests per mailbox). Implement a per‑mailbox queue or semaphore that throttles parallelism, sending batches sequentially for a given mailbox while you can run up to 4 different mailbox pipelines in parallel across tenants. If a 429 response is returned, honor the Retry‑After header (or apply exponential back‑off when it's missing) and retry the whole batch — on repeated failure fall back to individual send requests with unique message IDs so retries are idempotent. Finally, instrument retries with a circuit‑breaker or retry‑policy library, log throttling events, and use delta queries or change notifications to avoid unnecessary re‑sends, ensuring high reliability without overwhelming the service.

--- ADVERSARIAL JUDGE'S CRITIQUE ---
CRITIQUE:
Quick: Oversimplifies throttling by only limiting concurrent requests per mailbox and does not address batch size limits, retry handling, or idempotency concerns.  
Deep: Provides detailed limits but mixes too many advanced concepts (delta queries, Data Connect) that may be irrelevant for typical bulk send and lacks clear implementation steps for pacing and error handling.  
Hybrid: Balances detail and practicality but still leaves gaps around batch composition strategy, monitoring, and fallback to individual sends for partial batch failures.

--- FINAL SYNTHESIZED ANSWER ---
When sending large volumes of email with Microsoft Graph, follow these best‑practice steps:

1. **Know the limits** – Each mailbox allows up to 4 concurrent POST/PUT/PATCH operations, a total payload of ~150 MB (≈30 large messages) in any 5‑minute window, and the tenant is limited to 10 000 requests per 10 minutes.

2. **Use the $batch endpoint** – Group up to 20 `sendMail` calls into a single `/v1.0/$batch` request to minimise round‑trips. Remember that every sub‑request in the batch is still subject to the per‑mailbox limits, so a batch that tries to send more than 4 messages to the same mailbox at once will be throttled.

3. **Control concurrency per mailbox** – Implement a per‑mailbox semaphore or queue that allows at most 4 simultaneous sends (whether in a batch or as individual calls). Process batches **sequentially** for a given mailbox, but you can run several mailbox pipelines in parallel (e.g., up to 4 different mailboxes per tenant) to maximise throughput.

4. **Batch orchestration** –  
   * Partition your recipient list by mailbox (or tenant) first.  
   * Build batches of up to 20 messages, ensuring each batch contains ≤4 messages destined for any single mailbox.  
   * Submit batches asynchronously, respecting the semaphore count.

5. **Handle throttling and failures** –  
   * On a 429 response, read the **Retry‑After** header; if it's missing, apply an exponential back‑off (e.g., 2^n × 1 s, capped at 30 s).  
   * Retry the entire batch after the wait.  
   * If a batch repeatedly fails, fall back to sending the affected messages individually to isolate problematic items.  

6. **Idempotency** – Generate a stable `Message-Id` (or use the `internetMessageId` you supply) for every email and store it before sending; this lets you safely replay retries without creating duplicate messages.

7. **Reliability patterns** –  
   * Wrap the send logic in a retry‑policy library (Polly, Retry4J, etc.) with circuit‑breaker support to stop hammering the service after repeated throttles.  
   * Log each request, response status, Retry‑After values, and batch composition for diagnostics.  

8. **Avoid unnecessary sends** – Use Graph **delta queries** or **change notifications** to detect when a recipient's mailbox state changes, preventing duplicate or stale sends in iterative processes.

9. **When batch limits are a blocker** – For truly massive extract‑or‑send scenarios (hundreds of thousands of messages), consider **Microsoft Graph Data Connect** or a staged approach that moves data to Azure Storage first and then processes it in controlled chunks.

By combining the $batch endpoint for network efficiency, strict per‑mailbox concurrency controls, disciplined retry/back‑off handling, idempotent message IDs, and observability (logging + circuit‑breaker), you achieve high throughput while staying within Graph's throttling limits and maintaining reliability.
===========================================================================