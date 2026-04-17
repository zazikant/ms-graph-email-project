# Microsoft Graph Batch Email - Source Citations

## Primary Sources

### 1. Microsoft Graph Throttling Limits (Official Documentation)
- **URL:** https://learn.microsoft.com/en-us/graph/throttling-limits
- **Access Date:** 2025-04-15
- **Relevance:** Authoritative source for all rate limits
- **Key Excerpts:**
  - "Outlook service limits apply to each app ID and mailbox combination"
  - "10,000 API requests in a 10-minute period"
  - "Four concurrent requests"
  - "150 MB upload (PATCH, POST, PUT) in a 5-minute period"
- **Reliability:** 10/10 - Official Microsoft documentation

### 2. Microsoft Graph Throttling Guidance
- **URL:** https://learn.microsoft.com/en-us/graph/throttling
- **Access Date:** 2025-04-15
- **Relevance:** How to handle throttling in applications
- **Key Excerpts:**
  - "When throttling occurs, Microsoft Graph returns HTTP status code 429"
  - "Backing off requests using the Retry-After delay is the fastest way to recover"
  - "If no Retry-After header is provided, implement exponential backoff"
- **Reliability:** 10/10 - Official Microsoft documentation

### 3. JSON Batching in Microsoft Graph
- **URL:** https://learn.microsoft.com/en-us/graph/json-batching
- **Access Date:** 2025-04-15
- **Relevance:** How to implement batch requests
- **Key Excerpts:**
  - "Microsoft Graph supports batching up to 20 requests"
  - "Requests in a batch are evaluated individually against throttling limits"
  - "If any request exceeds limits, it fails with status 429"
- **Reliability:** 10/10 - Official Microsoft documentation

### 4. Microsoft Graph SDKs - Batch Requests
- **URL:** https://learn.microsoft.com/en-us/graph/sdks/batch-requests
- **Access Date:** 2025-04-15
- **Relevance:** SDK implementation patterns
- **Key Excerpts:**
  - "Automatic batching for request limits - SDK splits into batches of 20"
  - "BatchRequestContent simplifies creating batch payloads"
- **Reliability:** 10/10 - Official Microsoft documentation

## Secondary Sources

### 5. Microsoft Q&A - Per-Mailbox Throttling Limits
- **URL:** https://learn.microsoft.com/en-us/answers/questions/5853334/increasing-microsoft-graph-per-mailbox-throttling
- **Access Date:** 2025-04-15
- **Relevance:** Community confirmation that limits cannot be increased
- **Key Excerpts:**
  - "These limits are fixed service limits and are not customer-configurable"
  - "High-throughput SaaS designs should focus on load distribution across mailboxes"
- **Reliability:** 9/10 - Microsoft official Q&A

### 6. Refresh Tokens in Microsoft Identity Platform
- **URL:** https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- **Access Date:** 2025-04-15
- **Relevance:** Token lifetime and refresh information
- **Key Excerpts:**
  - "Refresh tokens - 90 days default for most scenarios"
  - "24 hours for single-page applications"
  - "Refresh tokens replace themselves with fresh token on use"
- **Reliability:** 10/10 - Official Microsoft documentation

### 7. Supabase Edge Functions - Sending Emails
- **URL:** https://supabase.com/docs/guides/functions/examples/send-emails
- **Access Date:** 2025-04-15
- **Relevance:** Edge Function implementation patterns
- **Key Excerpts:**
  - "150-second execution limit"
  - "Use Resend API for transactional emails"
- **Reliability:** 9/10 - Official Supabase documentation

### 8. Smart Graph Batch Retry Logic
- **URL:** https://jeppe-spanggaard.dk/blogs/graph-batch-smart-retry/
- **Access Date:** 2025-04-15
- **Relevance:** Practical retry implementation patterns
- **Key Excerpts:**
  - "NewBatchWithFailedRequests() method creates challenges"
  - "Implementation for selective retry on failures only"
- **Reliability:** 8/10 - Developer blog with working code

### 9. MS Graph SDK .NET - SendMail Batch Issue
- **URL:** https://github.com/microsoftgraph/msgraph-sdk-dotnet-core/issues/294
- **Access Date:** 2025-04-15
- **Relevance:** Known SDK limitations with SendMail batching
- **Key Excerpts:**
  - "Batch request does not work with SendMail"
  - Workaround: Convert to HttpRequestMessage before adding to batch
- **Reliability:** 9/10 - GitHub issue from Microsoft Graph team

### 10. Microsoft Q&A - Email Limits
- **URL:** https://learn.microsoft.com/en-us/answers/questions/2123005/it-is-not-clear-to-me-the-exact-number-of-mails-i
- **Access Date:** 2025-04-15
- **Relevance:** Exchange Online daily limits clarification
- **Key Excerpts:**
  - "Exchange Online limits 10,000 emails every 24 hours per mailbox"
  - "Graph API limit is 10,000 requests per 10 minutes"
- **Reliability:** 9/10 - Microsoft official Q&A

---

## Source Reliability Summary

| Category | Count | Avg Reliability |
|----------|-------|-------------|
| Official Microsoft Docs | 6 | 10/10 |
| Microsoft Q&A | 2 | 9/10 |
| GitHub Issues | 1 | 9/10 |
| Developer Blog | 1 | 8/10 |

**Overall Research Reliability:** 9.5/10 - Based primarily on official Microsoft documentation