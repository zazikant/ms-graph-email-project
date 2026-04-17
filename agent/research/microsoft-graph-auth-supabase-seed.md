# Microsoft Graph Auth Supabase - Research Seed

## Original Query
Microsoft Graph API authentication flow for Supabase Edge Functions: Client Credentials vs Authorization Code flow, secure storage and refresh using Supabase Database and Vault

===========================================================================
QUERY: Microsoft Graph API authentication flow for Supabase Edge Functions: Client Credentials vs Authorization Code flow, secure storage and refresh using Supabase Database and Vault

INTENT: search

--- STRATEGY OUTPUTS ---

[QUICK]:
Edge Functions expect a bearer token in the Authorization header, which you can enforce or disable via the function’s auth settings. Microsoft Graph API requires an authorized app (e.g., using client‑credentials or authorization‑code flow), and the required secret can be kept securely in Supabase’s database or a Vault for token refresh.

[DEEP]:
**Microsoft Graph API ↔ Supabase Edge Functions – which auth flow to use and how to keep the tokens safe**

| Flow | When it’s appropriate for an Edge Function | How you obtain/refresh the token | Where you keep the secret / refresh data | Typical Edge‑Function code pattern |
|------|--------------------------------------------|----------------------------------|----------------------------------------|-----------------------------------|
| **Client‑Credentials (app‑only)** | Your function only needs to act on behalf of the app (e.g., write to a SharePoint list, read organizational data). No user consent is required. | `POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with `grant_type=client_credentials`, `client_id`, `client_secret`, and the Graph scopes. The response contains an **access‑token** that expires in ~1 hour; there is **no refresh token** – you simply request a new token when the old one expires. | Store the **client secret** as an Edge‑Function secret (`SB_MS_GRAPH_CLIENT_SECRET`). The secret is injected at runtime via `Deno.env.get('SB_MS_GRAPH_CLIENT_SECRET')`. Because you never persist a user‑specific token, you don’t need a vault for refresh data. | ```ts\nimport { createClient } from '@supabase/supabase-js'\nconst supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)\n\nasync function getAppToken() {\n  const resp = await fetch(`https://login.microsoftonline.com/${Deno.env.get('SB_MS_GRAPH_TENANT_ID')}/oauth2/v2.0/token`, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },\n    body: new URLSearchParams({\n      client_id: Deno.env.get('SB_MS_GRAPH_CLIENT_ID')!,\n      client_secret: Deno.env.get('SB_MS_GRAPH_CLIENT_SECRET')!,\n      scope: 'https://graph.microsoft.com/.default',\n      grant_type: 'client_credentials'\n    })\n  })\n  const { access_token } = await resp.json()\n  return access_token\n}\n\nDeno.serve(async (req) => {\n  const token = await getAppToken()\n  const graphResp = await fetch('https://graph.microsoft.com/v1.0/me', {\n    headers: { Authorization: `Bearer ${token}` }\n  })\n  return new Response(await graphResp.text(), { status: graphResp.status })\n})\n``` |

| **Authorization‑Code (delegated)** | You need to act on **individual users** (e.g., read a user’s mailbox, write a Teams message). The flow requires a front‑end to capture the consent UI and a back‑end to exchange the code. | 1️⃣ Front‑end sends the user to `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?...&response_type=code`. <br>2️⃣ Edge Function receives the `code` (via a POST from your SPA) and calls the token endpoint with `grant_type=authorization_code`. <br>3️⃣ The response supplies an **access‑token** (short‑lived) *and* a **refresh‑token** (long‑lived). | • **Client secret** → same secret handling as above (`SB_MS_GRAPH_CLIENT_SECRET`). <br>• **Refresh‑token** → encrypted in a Supabase table (`user_id, encrypted_refresh_token`). Use `pgcrypto` (`crypt`/`gen_salt`) or a server‑side Vault (HashiCorp, Azure Key Vault) referenced by a secret (`SB_VAULT_URL`). Only the Edge Function, created with the `service_role` key, can read/write this column, and RLS prevents any other client from seeing it. | ```ts\n// 1️⃣ Exchange auth‑code → tokens (run inside an Edge Function)\nexport const handler = async (req: Request) => {\n  const { code, state } = await req.json()\n  const tokenRes = await fetch(`https://login.microsoftonline.com/${Deno.env.get('SB_MS_GRAPH_TENANT_ID')}/oauth2/v2.0/token`, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },\n    body: new URLSearchParams({\n      client_id: Deno.env.get('SB_MS_GRAPH_CLIENT_ID')!,\n      client_secret: Deno.env.get('SB_MS_GRAPH_CLIENT_SECRET')!,\n      code,\n      redirect_uri: Deno.env.get('SB_MS_GRAPH_REDIRECT_URI')!,\n      grant_type: 'authorization_code'\n    })\n  })\n  const { access_token, refresh_token, expires_in } = await tokenRes.json()\n\n  // 2️⃣ Persist encrypted refresh token\n  const { error } = await supabase.from('ms_graph_tokens').upsert({\n    user_id: state,                              // state == your app’s user‑id\n    enc_refresh: await encrypt(refresh_token)    // a small helper that uses pgcrypto\n  })\n  if (error) throw error\n\n  //

[HYBRID]:
**Use the Authorization Code flow for any Graph call that must act on behalf of a logged‑in user, and fall back to the Client‑Credentials flow only for app‑only operations (e.g., reading organizational data that isn’t user‑specific).**  
In an Edge Function you first validate the Supabase JWT (via the `Authorization: Bearer <supabase‑anon‑or‑service‑key>` header) and, if the client sent an auth‑code payload, exchange it for a Microsoft Graph access + refresh token using your Azure AD **client_id/secret** (kept in `Deno.env` and optionally mirrored in a Supabase‑managed secret vault).  
Persist the resulting refresh token in a Supabase table encrypted with a key stored in the same vault; the function can silently refresh the Graph access token whenever it expires, updating the DB entry without ever exposing secrets to the mobile app.  
Thus, user‑initiated calls use Authorization Code (user context + RLS), while background calls use Client Credentials (service context), with all secrets securely stored in the Supabase environment variables and/or an external Vault and refreshed via the database‑backed token cache.

--- ADVERSARIAL JUDGE'S CRITIQUE ---
CRITIQUE:
Quick: Overly brief and vague, missing concrete guidance on token lifecycle, storage mechanisms, and when to choose each OAuth flow.  
Deep: Very detailed and accurate but focuses on separate flows without clearly explaining how to decide between them or how to integrate both within a single Edge Function architecture.  
Hybrid: Provides a sensible decision matrix but lacks concrete implementation details, code samples, and explicit guidance on secure secret handling and refresh‑token storage.

--- FINAL SYNTHESIZED ANSWER ---
**Choosing the right Microsoft Graph authentication flow for Supabase Edge Functions**  

1. **When to use each flow**  
   * **Client‑Credentials (app‑only) flow** – Use when the function needs to act on behalf of the application rather than a specific user (e.g., reading organization‑wide SharePoint lists, posting to a Teams channel that isn’t user‑specific, or any background job). No user consent is required and the token is short‑lived (≈1 hour) with no refresh token; you simply request a new token each time the old one expires.  
   * **Authorization‑Code (delegated) flow** – Use when the function must act as the logged‑in user (e.g., reading a user’s mailbox, creating a Teams chat for that user, accessing their OneDrive). This flow yields an access token **and** a refresh token, allowing long‑term access without repeatedly prompting the user.  

2. **Secure storage of credentials**  
   * **Client secret** – Store the Azure AD client secret as an Edge‑Function secret (`SB_MS_GRAPH_CLIENT_SECRET`) or in Supabase’s built‑in secret store. The value is injected as an environment variable (`Deno.env.get(...)`) and never exposed to the client.  
   * **Refresh tokens (delegated flow)** – Persist refresh tokens in a Supabase table that is only accessible with the `service_role` key. Encrypt the token at rest with either:  
     - PostgreSQL `pgcrypto` (`pgp_sym_encrypt`) using a key kept in another secret (`SB_ENC_KEY`), or  
     - An external Vault (HashiCorp, Azure Key Vault, AWS Secrets Manager) referenced by a secret URL (`SB_VAULT_URL`).  
     Apply Row‑Level Security (RLS) so that ordinary users cannot read the column.  

3. **Token acquisition & refresh pattern**  
   * **Client‑Credentials** – Inside the Edge Function, call the Azure token endpoint with `grant_type=client_credentials`, client‑id, client‑secret, and the Graph scope `https://graph.microsoft.com/.default`. Parse the `access_token` and use it for the Graph request. When the call fails with 401 or after ~55 minutes, repeat the request to get a fresh token. No DB write is needed.  
   * **Authorization‑Code** –  
     1. Front‑end redirects the user to Azure’s authorize URL (`response_type=code`).  
     2. After consent, Azure redirects back to your SPA which POSTs the received `code` (and a state that maps to your Supabase user id) to an Edge Function endpoint.  
     3. The Edge Function exchanges the code for `access_token` + `refresh_token`.  
     4. Encrypt and upsert the `refresh_token` into the `ms_graph_tokens` table (`user_id`, `enc_refresh`).  
     5. For subsequent calls, the function reads the encrypted token, decrypts it, checks the access token’s expiry, and if expired uses the stored refresh token to obtain a new access token (and possibly a new refresh token). Update the DB entry with the new encrypted refresh token.  

4. **Typical Edge Function skeleton (TypeScript/Deno)**  

```typescript
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
)

// ---------- Helper to get app‑only token ----------
async function getAppToken() {
  const resp = await fetch(
    `https://login.microsoftonline.com/${Deno.env.get('SB_MS_GRAPH_TENANT_ID')}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('SB_MS_GRAPH_CLIENT_ID')!,
        client_secret: Deno.env.get('SB_MS_GRAPH_CLIENT_SECRET')!,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      })
    }
  )
  const { access_token } = await resp.json()
  return access_token
}

// ---------- Helper to get/refresh delegated token ----------
async function getUserToken(userId: string) {
  const { data, error } = await supabase
    .from('ms_graph_tokens')
    .select('enc_refresh')
    .eq('user_id', userId)
    .single()
  if (error) throw error

  const refreshToken = await decrypt(data.enc_refresh) // your decryption util
  const tokenResp = await fetch(
    `https://login.microsoftonline.com/${Deno.env.get('SB_MS_GRAPH_TENANT_ID')}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('SB_MS_GRAPH_CLIENT_ID')!,
        client_secret: Deno.env.get('SB_MS_GRAPH_CLIENT_SECRET')!,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: 'https://graph.microsoft.com/.default',
      })
    }
  )
  const { access_token, refresh_token, expires_in } = await tokenResp.json()

  // rotate refresh token if Azure gave a new one
  if (refresh_token) {
    const enc = await encrypt(refresh_token)
    await supabase
      .from('ms_graph_tokens')
      .upsert({ user_id: userId, enc_refresh: enc })
  }
  return { access_token, expires_in }
}

// ---------- Edge Function entry point ----------
Deno.serve(async (req: Request) => {
  // Verify Supabase JWT from client (optional but recommended)
  const auth = req.headers.get('authorization')?.split(' ')[1]
  const { data: supaUser, error } = await supabase.auth.api.getUser(auth!)
  if (error) return new Response('Unauthorized', { status: 401 })

  // Logic to handle request...
})
```

===========================================================================
