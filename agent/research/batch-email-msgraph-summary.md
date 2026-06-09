# Microsoft Graph Batch Email Sending - Deep Research Summary

## Executive Summary

This deep research provides specific, actionable recommendations for improving batch email sending with Microsoft Graph API. The key findings are:

1. **Rate limits are FIXED and cannot be increased** - The per-mailbox limits (10,000 requests/10 min, 4 concurrent, 150 MB/5 min) are enforced at the service level
2. **JSON batching provides network efficiency but has limitations** - Maximum 20 requests per batch, but individual requests still evaluated against throttling limits
3. **Outlook batch processing is automatic** - Microsoft Graph automatically limits concurrent batch requests to 4 per mailbox, making explicit throttling less critical
4. **Token refresh should be handled proactively** - For long batch operations, check token expiration before sending

---

## Key Findings

### 1. Microsoft Graph API Rate Limits (Per Mailbox)

Based on official Microsoft documentation (updated January 2025):

| Limit Type | Value | Scope |
|-----------|-------|-------|
| API requests | 10,000 per 10 minutes | Per app ID + mailbox |
| Concurrent requests | 4 | Per app ID + mailbox |
| Upload size | 150 MB per 5 minutes | PATCH/POST/PUT operations |

**Critical Notes:**
- These limits are **fixed and cannot be increased** through tenant settings or admin configuration
- Limits apply per app ID + mailbox combination - exceeding one mailbox doesn't affect others
- Exchange Online also has a 10,000 emails per 24-hour limit per mailbox (separate from Graph API limits)

### 2. Batch vs Sequential Sending Approaches

**JSON Batching:**
- Maximum 20 individual requests per batch request
- Each sub-request evaluated individually against throttling limits
- Batch overall returns 200 OK even if individual requests get 429
- Must parse individual response statuses

**Outlook-Specific Behavior:**
- By default, Microsoft Graph sends **up to 4 requests from a batch at a time** to Outlook
- This automatic throttling keeps requests within Outlook's 4-concurrent limit
- For ordered execution, use the `dependsOn` property

**Recommended Approach:**
- Use JSON batching (up to 20) for network efficiency
- Process multiple batches sequentially if targeting the same mailbox
- For different mailboxes, batches can run in parallel (4 concurrent per mailbox)

### 3. Token Refresh Considerations

**Token Lifetime (Microsoft Entra ID):**
- Access tokens: Typically 1 hour (varies by configuration)
- Refresh tokens: 90 days default for most scenarios, 24 hours for SPAs

**For Long-Running Batch Operations:**
- Check token expiration before starting batch operation
- Implement proactive token refresh ~5 minutes before expiration
- Store and reuse refresh token - it's valid until expiration

### 4. Supabase Edge Function Patterns

**Execution Limits:**
- 150-second wall clock time limit
- Suitable for batch sizes of 50-100 emails per invocation depending on payload size

**Recommended Patterns:**
- Database-driven queue with pg_cron for large volumes
- Individual Edge Function invocations for smaller batches with built-in retry
- Implement exponential backoff for 429 handling

---

## Actionable Recommendations

### Immediate Improvements

1. **Implement Per-Mailbox Rate Limiting**
   ```typescript
   // Never exceed 4 concurrent requests per mailbox
   // Use semaphore pattern per sender mailbox
   const mailboxes = getUniqueSenderMailboxes(recipients);
   for (const mailbox of mailboxes) {
     await processMailboxBatches(mailbox, recipients, {
       maxConcurrent: 4,
       maxPerBatch: 20
     });
   }
   ```

2. **Use JSON Batching for Network Efficiency**
   - Group up to 20 sendMail requests per $batch call
   - Parse individual response statuses (not just batch status)
   - Handle individual 429 responses with retry

3. **Implement Proper Retry Logic**
   ```typescript
   async function sendWithRetry(message: EmailMessage): Promise<void> {
     for (let attempt = 1; attempt <= 3; attempt++) {
       try {
         await sendMail(message);
         return;
       } catch (error) {
         if (error.status === 429) {
           const retryAfter = error.headers.get('Retry-After') || Math.pow(2, attempt);
           await sleep(retryAfter * 1000);
         }
       }
     }
     throw new Error('Failed after 3 retries');
   }
   ```

4. **Monitor Token Expiration**
   ```typescript
   // Check before long batch operation
   if (isTokenExpiringSoon(accessToken, 5 * 60 * 1000)) {
     const tokenResponse = await refreshToken(refreshToken);
     accessToken = tokenResponse.access_token;
   }
   ```

### For Large Volume Improvements

5. **Database-Driven Queue Pattern**
   - Store pending emails in database table
   - Use pg_cron to process in batches
   - Edge Function processes next N records per invocation
   - This handles volumes exceeding single invocation limits

6. **Distributed Processing**
   - For multiple sender mailboxes, parallelize across mailboxes
   - Each mailbox has its own rate limit budget
   - Use 4 concurrent requests per mailbox as the key constraint

---

## Implementation Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Rate Limits | 10/10 | Official Microsoft documentation - fixed, cannot be increased |
| JSON Batching | 9/10 | Well-documented with some SDK-specific quirks |
| Retry Logic | 9/10 | Standard exponential backoff with Retry-After header |
| Token Handling | 8/10 | Depends on tenant configuration |
| Supabase Patterns | 8/10 | General patterns apply, specific implementation needed |

---

## References

- **Official Documentation:** https://learn.microsoft.com/en-us/graph/throttling-limits
- **JSON Batching:** https://learn.microsoft.com/en-us/graph/json-batching
- **Throttling Guidance:** https://learn.microsoft.com/en-us/graph/throttling

---

## Next Steps

1. Review current batch implementation against these findings
2. Implement per-mailbox semaphores if not already present
3. Add proper 429 handling with Retry-After support
4. Consider database queue for volumes > 1000 emails/day
5. Test token refresh handling in production workflow

*See also: batch-email-msgraph-sources.md for detailed citations and batch-email-msgraph-examples.md for verified code implementations*