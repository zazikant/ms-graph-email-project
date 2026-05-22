# Sources: supabase-cron-wakeup

## Primary Sources

### 1. Supabase CLI Reference Documentation
- **URL**: https://supabase.com/docs/reference/cli/supabase-functions
- **Access Date**: 2026-05-22
- **Relevance**: Documents Edge Functions CLI commands including deploy, list, serve
- **Reliability**: 10/10 (Official Supabase Documentation)
- **Key Excerpts**:
  - Edge Functions subcommands: create, list, download, serve, deploy, delete
  - Requires `supabase login` before deployment
  - Project must be linked via `supabase link --project-ref <id>`
- **Notes**: The schedule subcommand appears in CLI but documentation was incomplete at time of research

### 2. Supabase Edge Functions Overview
- **URL**: https://supabase.com/docs/guides/functions
- **Access Date**: 2026-05-22
- **Relevance**: Core documentation for Edge Functions concept and architecture
- **Reliability**: 10/10 (Official Supabase Documentation)
- **Key Excerpts**:
  - "Edge Functions are server-side TypeScript functions, distributed globally at the edge"
  - "Developed using Deno" - open source, portable, TypeScript first
  - Runtime: Supabase Edge Runtime (Deno compatible)
  - Cold starts possible - design for short-lived, idempotent operations
  - Use secrets via `supabase secrets` commands

### 3. Supabase Edge Functions Examples (GitHub)
- **URL**: https://github.com/supabase/supabase/tree/master/examples/edge-functions
- **Access Date**: 2026-05-22
- **Relevance**: Working code examples for Edge Functions
- **Reliability**: 9/10 (Official Supabase GitHub Repository)
- **Key Excerpts**:
  - Deployment workflow: login → link → secrets set → deploy
  - GitHub Actions deployment example included
  - JWT verification can be disabled per function via config.toml

### 4. Supabase Database Extensions
- **URL**: https://supabase.com/docs/guides/database/extensions
- **Access Date**: 2026-05-22
- **Relevance**: Confirms pg_cron is a pre-installed extension
- **Reliability**: 10/10 (Official Supabase Documentation)
- **Key Excerpts**:
  - "Supabase has pre-installed some of the most useful open source extensions"
  - Enable via SQL: `create extension pg_cron;`
  - Extensions installed under `extensions` schema

### 5. Supabase Edge Functions Background Tasks
- **URL**: https://supabase.com/docs/guides/functions/background-tasks
- **Access Date**: 2026-05-22
- **Relevance**: Documents `EdgeRuntime.waitUntil()` for async processing
- **Reliability**: 10/10 (Official Supabase Documentation)
- **Key Excerpts**:
  - Background tasks extend function lifetime
  - Use for async operations like uploads, db updates, logging

### 6. Seed Research Document
- **URL**: D:\test\ms-graph-email-project\agent\research\supabase-cron-wakeup-seed.md
- **Access Date**: 2026-05-22
- **Relevance**: Initial AI-generated research with strategy outputs
- **Reliability**: 6/10 (AI-generated, not primary source)
- **Key Excerpts**:
  - Provided Edge Function schedule CLI syntax
  - Provided pg_cron SQL syntax
  - Both approaches outlined with cron pattern `0 0 * * *`

---

## Secondary Sources

### 7. Supabase CLI v1 Blog Post
- **URL**: https://supabase.com/blog/supabase-cli-v1-and-admin-api-beta
- **Access Date**: 2026-05-22
- **Relevance**: Documents CLI capabilities including Management API
- **Reliability**: 9/10 (Official Supabase Blog)
- **Key Excerpts**:
  - CLI can manage organizations, projects, Edge Functions
  - `supabase link --project-ref` required before deployment
  - Management API enables programmatic project management

### 8. Supabase Local Development (CLI)
- **URL**: https://supabase.com/docs/guides/local-development/cli/getting-started
- **Access Date**: 2026-05-22
- **Relevance**: Documents `supabase start`, `supabase functions serve`
- **Reliability**: 10/10 (Official Documentation)
- **Key Excerpts**:
  - Local Edge Function development with `supabase functions serve`
  - JWT verification can be disabled with `--no-verify-jwt`

---

## Additional Notes

### Source Reliability Assessment

| Source | Score | Reason |
|--------|-------|--------|
| Official Supabase Docs (functions, extensions) | 10/10 | Primary authoritative source |
| GitHub Examples | 9/10 | Official repo, working code |
| Blog posts | 9/10 | Official source |
| Seed research (AI-generated) | 6/10 | Not a primary source, provided syntax hints |

### Documentation Gaps

1. **Edge Function scheduling**: The specific `supabase functions schedule create` command syntax was not fully documented in the official docs at time of research. The seed research provided this syntax which should be verified with `supabase functions schedule --help`.

2. **pg_cron specific docs**: Dedicated pg_cron documentation page was not accessible (404 on expected paths). The general extensions page confirms availability.

### Cross-Validation Status

- ✅ Edge Functions concept and deployment: Verified across multiple sources
- ✅ pg_cron as pre-installed extension: Verified via extensions docs
- ⚠️ Schedule CLI syntax: Partially verified (from seed, needs CLI verification)
- ✅ pg_cron SQL syntax: Standard PostgreSQL, aligns with pg_cron documentation
- ✅ Cron pattern `0 0 * * *`: Standard cron syntax (midnight UTC)

---

*See also: supabase-cron-wakeup-summary.md for executive summary and supabase-cron-wakeup-examples.md for code implementations*