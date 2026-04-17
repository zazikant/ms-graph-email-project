# Microsoft Graph Auth Supabase - Sources

## Primary Sources

### Microsoft Entra ID - OAuth 2.0 Auth Code Flow
- **URL:** https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
- **Access Date:** 2026-04-14
- **Relevance:** Definitive guide for Microsoft Graph authentication protocols, including PKCE requirements and token endpoint parameters.
- **Reliability:** 10/10 (Official Documentation)

### Supabase Vault Documentation
- **URL:** https://supabase.com/docs/guides/database/vault
- **Access Date:** 2026-04-14
- **Relevance:** Explains how to enable and use the Vault extension for secure secret storage in Postgres.
- **Reliability:** 10/10 (Official Documentation)

### MakerKit - Supabase Vault Tutorial
- **URL:** https://makerkit.dev/blog/tutorials/supabase-vault
- **Access Date:** 2026-04-14
- **Relevance:** Provides practical SQL and TypeScript patterns for wrapping Vault calls in reusable functions.
- **Reliability:** 8/10 (Verified Community Tutorial)

## Secondary Sources

### Nango - Microsoft OAuth invalid_grant guide
- **URL:** https://nango.dev/blog/microsoft-oauth-refresh-token-invalid-grant/
- **Access Date:** 2026-04-14
- **Relevance:** Deep dive into specific failure modes of Microsoft refresh tokens (SPA vs Web App lifetimes).
- **Reliability:** 7/10 (Technical Blog)

### Deno Crypto Documentation
- **URL:** https://docs.deno.com/api/deno/~/Deno.SubtleCrypto
- **Access Date:** 2026-04-14
- **Relevance:** Reference for implementing SHA256 hashing required for PKCE code challenges in Deno.
- **Reliability:** 10/10 (Official Documentation)
