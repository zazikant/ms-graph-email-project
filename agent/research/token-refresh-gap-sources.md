# Token Refresh Gap — Source Citations

All sources accessed 2026-06-11. Reliability scores use the scale
0 (untrusted) – 10 (authoritative, current).

## Primary Sources (Official Microsoft)

### 1. Microsoft Learn — Refresh tokens in the Microsoft identity platform
- **URL:** https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens
- **Access Date:** 2026-06-11
- **Relevance:** Definitive reference for refresh token lifetime, rotation, and
  revocation policies.
- **Key Excerpts:**
  - "Refresh tokens replace themselves with a fresh token upon every use. The
    Microsoft identity platform doesn't revoke old refresh tokens when used to
    fetch new access tokens. Securely delete the old refresh token after
    acquiring a new one."
  - "The default lifetime for the refresh tokens are as follows: 24 hours for
    single-page applications. 24 hours for apps that use email one-time passcode
    authentication flow. 90 days for all other scenarios."
  - Confidential-client token revocation table (admin reset, password change,
    SSPR, etc.).
- **Reliability:** 10/10 — Official Microsoft Learn documentation, updated
  2025-11-05.

### 2. Microsoft Learn — OAuth 2.0 authorization code flow (refresh leg)
- **URL:** https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#refresh-the-access-token
- **Access Date:** 2026-06-11
- **Relevance:** The exact HTTP body and parameters for `grant_type=refresh_token`,
  and the OAuth 2.0 spec citation on rotation.
- **Key Excerpts:**
  - "Refresh tokens aren't revoked when used to acquire new access tokens.
    You're expected to discard the old refresh token. The OAuth 2.0 spec
    says: 'The authorization server MAY issue a new refresh token, in which
    case the client MUST discard the old refresh token and replace it with the
    new refresh token. The authorization server MAY revoke the old refresh
    token after issuing a new refresh token to the client.'"
  - Token endpoint error code table: `invalid_grant` = "The authorization code
    or PKCE code verifier is invalid or has expired. Try a new request to the
    `/authorize` endpoint…"
  - Required parameters for refresh: `client_id`, `grant_type=refresh_token`,
    `refresh_token`, `client_secret` (for confidential web apps). Optional
    `scope` (must be a subset of original scopes).
- **Reliability:** 10/10 — Official, updated 2026-01-22.

### 3. Microsoft Learn — OAuth 2.0 and OpenID Connect protocols (overview)
- **URL:** https://learn.microsoft.com/en-us/entra/identity-platform/v2-protocols
- **Access Date:** 2026-06-11
- **Relevance:** Confirms role of `refresh_token` (RT) in OAuth 2.0 flows and
  the `/{tenant}/oauth2/v2.0/token` endpoint pattern.
- **Key Excerpts:**
  - "Refresh tokens - The client uses a refresh token, or *RT*, to request new
    access and ID tokens from the authorization server. Your code should treat
    refresh tokens and their string content as sensitive data because they're
    intended for use only by authorization server."
  - Endpoint template: `https://login.microsoftonline.com/<issuer>/oauth2/v2.0/token`.
- **Reliability:** 10/10 — Official.

## Primary Sources (Official Supabase)

### 4. Supabase Docs — Development Environment / Project Structure
- **URL:** https://supabase.com/docs/guides/functions/development-environment
- **Access Date:** 2026-06-11
- **Relevance:** Official guidance for shared code in Edge Functions.
- **Key Excerpts:**
  - "Store shared code in `_shared`. Store any shared code in a folder prefixed
    with an underscore (`_`)."
  - Recommended layout:
    ```
    supabase/functions/
    ├── _shared/
    │   ├── supabaseAdmin.ts
    │   ├── supabaseClient.ts
    │   └── cors.ts
    ├── function-one/
    │   └── index.ts
    └── function-two/
        └── index.ts
    ```
  - "Use 'fat functions'. Develop few, large functions by combining related
    functionality. This minimizes cold starts."
  - "Name functions with hyphens (`-`)."
- **Reliability:** 10/10 — Official Supabase documentation.

### 5. Supabase Docs — Managing dependencies (deno.json / import_map)
- **URL:** https://supabase.com/docs/guides/functions/import-maps
- **Access Date:** 2026-06-11
- **Relevance:** Confirms each function is its own bundle and relative imports
  from `_shared/` are resolved at build time.
- **Key Excerpts:**
  - "Each function should have its own `deno.json` file to manage dependencies
    and configure Deno-specific settings. This ensures proper isolation
    between functions and is the recommended approach for deployment."
  - "It's possible to use a global `deno.json` in the `/supabase/functions`
    directory for local development, but this approach is not recommended for
    deployment. Each function should maintain its own configuration to ensure
    proper isolation and dependency management."
- **Reliability:** 10/10 — Official Supabase documentation.

### 6. Supabase Docs — Deploy to Production
- **URL:** https://supabase.com/docs/guides/functions/deploy
- **Access Date:** 2026-06-11
- **Relevance:** Confirms `supabase functions deploy <name>` deploys each
  function as an independent bundle.
- **Key Excerpts:**
  - "You can deploy all edge functions within the `functions` folder with a
    single command: `supabase functions deploy`. Or deploy individual Edge
    Functions by specifying the function name."
  - "When the deployment is successful, your function is automatically
    distributed to edge locations worldwide."
- **Reliability:** 10/10 — Official.

## Secondary Sources (CLI source / PR confirmations)

### 7. supabase/cli#1740 — preserve file extension when bundling
- **URL:** https://github.com/supabase/cli/pull/1740
- **Access Date:** 2026-06-11
- **Relevance:** Confirms the esbuild bundler resolves relative imports like
  `../_shared/foo.ts` correctly (the `.ts` extension must be preserved in the
  import path).
- **Key Excerpts:**
  - "Preserves imported file extension so that deno is happy."
  - Fixes #1739 "`supabase functions deploy` fails".
- **Reliability:** 9/10 — Official Supabase CLI repo, merged PR.

## In-repo Evidence

### 8. supabase/functions/_shared/getOAuthConfig.ts (current file)
- **Path:** `D:\test\ms-graph-email-project\supabase\functions\_shared\getOAuthConfig.ts`
- **Access Date:** 2026-06-11
- **Relevance:** Existing proof that the `_shared/` import pattern is already
  used in this repo.
- **Key Excerpts:**
  - File lives at `supabase/functions/_shared/getOAuthConfig.ts` (underscore
    prefix).
  - Imported by `process-batches/index.ts` via
    `import { getOAuthConfig } from "../_shared/getOAuthConfig.ts"` (verified
    via Grep on the function folder).
- **Reliability:** 10/10 — Direct in-repo evidence.

### 9. supabase/functions/process-batches/index.ts (current code)
- **Path:** `D:\test\ms-graph-email-project\supabase\functions\process-batches\index.ts`
- **Access Date:** 2026-06-11
- **Relevance:** Source of truth for the existing `tryRefreshToken` helper and
  the `processing_since` lock pattern.
- **Key Excerpts:**
  - Line 81–161: `tryRefreshToken` function body (refresh_token request,
    `invalid_grant` handler, status writes).
  - Line 119–127: `invalid_grant` handler that nulls `refresh_token` and sets
    `status='token_expired'`.
  - Line 137: `const newRefreshToken = tokens.refresh_token || currentRefreshToken`
    (rotation handling).
  - Line 292–304: `processing` lock with 2-hour `processing_since` timeout.
  - Line 327–355: proactive 5-minute-before-expiry refresh.
  - Line 359: sets `status='processing', processing_since=now()` before
    mid-batch send.
- **Reliability:** 10/10 — Direct in-repo evidence.

### 10. supabase/migrations/20260609000001_add_refresh_token_and_oauth.sql
- **Path:** `D:\test\ms-graph-email-project\supabase\migrations\20260609000001_add_refresh_token_and_oauth.sql`
- **Access Date:** 2026-06-11
- **Relevance:** Migration that introduced the `refresh_token` column and the
  `paused` batch status; also recovers previously-failed batches back to
  `pending`.
- **Key Excerpts:**
  - Line 5–7: `ALTER TABLE public.user_ms_graph_links ADD COLUMN IF NOT EXISTS
    refresh_token text;`
  - Line 86–90: batches CHECK constraint extended with `paused`:
    `CHECK (status IN ('pending', 'scheduled', 'processing', 'completed', 'paused', 'failed'))`
  - Line 92–105: Backfill SQL that flips `failed` batches back to `pending`
    if they have any `pending` recipients. This is the self-heal precedent.
- **Reliability:** 10/10 — Direct in-repo evidence.

## Tertiary / Community Sources (consumed for context, not as primary citation)

### 11. Nango — Microsoft OAuth refresh token invalid_grant guide
- **URL:** https://nango.dev/blog/microsoft-oauth-refresh-token-invalid-grant/
- **Access Date:** 2026-06-11
- **Relevance:** Practitioner blog confirming failure modes (SPA vs Web App
  lifetimes, common invalid_grant causes).
- **Reliability:** 7/10 — Technical blog, not authoritative; used only to
  cross-validate the official MS docs above.

---

## Source Reliability Summary

| Category                      | Count | Avg Reliability |
|-------------------------------|-------|-----------------|
| Official Microsoft Learn      | 3     | 10/10           |
| Official Supabase docs        | 3     | 10/10           |
| Official Supabase CLI repo    | 1     | 9/10            |
| In-repo evidence              | 3     | 10/10           |
| Community blog                | 1     | 7/10            |

**Overall research reliability:** 9.6/10 — Based primarily on official
Microsoft and Supabase documentation, cross-validated against the current
state of the repository.
