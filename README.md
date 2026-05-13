# Nakatomi CRM — Cloudflare edition

> A headless CRM built for AI agents, running on Cloudflare Workers.
> REST + MCP, D1 + R2 + KV + Queues + Vectorize-ready, OAuth 2.1 + PKCE.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Runtime](https://img.shields.io/badge/runtime-cloudflare%20workers-f38020.svg)](https://workers.cloudflare.com/)
[![Tests](https://img.shields.io/badge/tests-106%20passing-7ee787.svg)](#tests)

## What's here

A full port of the FastAPI/SQLAlchemy/Postgres [NakatomiCRM](https://github.com/mrdulasolutions/NakatomiCRM) onto Cloudflare's stack. Every legacy router has been re-implemented in TypeScript on Hono + Drizzle; every Cloudflare primitive that earns its keep is wired up; the original Python source is preserved under [`legacy/`](./legacy) as a read-only reference.

| Phase | Scope | Status |
| --- | --- | --- |
| A.1 | Workers scaffold (Hono, wrangler, Vitest, env types) | ✅ |
| A.2 | Drizzle schema (27 tables) + D1 migrations + FTS5 | ✅ |
| A.3 | Auth (PBKDF2 + JWT + API keys + KV rate-limit) | ✅ |
| B   | 13 CRUD routers — contacts, companies, pipelines, stages, deals, products, line items, activities, notes, tasks, custom fields, relationships, timeline, dashboard, workspaces | ✅ |
| C   | Files (R2), exports, ingest (JSON + CSV) | ✅ |
| D.1 | Webhooks with HMAC + Queues-ready delivery | ✅ |
| D.2 | Memory adapters (DocDeploy, Supermemory, GBrain) | ✅ |
| D.3 | OAuth 2.1 + PKCE provider for MCP clients | ✅ |
| E   | Email (Resend) + calendar (iCal HTTPS) | ✅ |
| F   | MCP server (streamable HTTP) + welcome flow | ✅ |
| G   | CI → wrangler deploy, seed script, docs refresh | ✅ |

## Cloudflare bindings

Declared in [`wrangler.toml`](./wrangler.toml):

| Binding | Resource | Role |
| --- | --- | --- |
| `DB` | D1 | Primary SQL — 27 tables + FTS5 virtual tables |
| `FILES` | R2 | Attachments and exports |
| `SESSIONS` | KV | Session state, JWT denylist |
| `RATE_LIMIT` | KV | Per-key sliding window |
| `IDEMPOTENCY` | KV | `Idempotency-Key` dedup |
| `ASSETS` | Static assets | `/llms.txt`, `/.well-known/agent.json`, logos |
| Cron Triggers | — | Webhook redelivery sweep, forecast rollups, GC |

Three additional bindings are commented in `wrangler.toml`, ready to switch on per-phase:
- **Queues** (`WEBHOOK_QUEUE`, `INGEST_QUEUE`) — webhook delivery already speaks Queues; flipping on the binding moves it from in-process to durable mode with no code change.
- **Vectorize** (`VECTORS`) — semantic memory + dedup.
- **Workers AI** (`AI`) — embeddings, summaries, deal scoring.

## Quickstart

### Local

```bash
npm install
cp .dev.vars.example .dev.vars       # set JWT_SECRET (openssl rand -hex 32)
npm run cf:bootstrap                 # creates D1 + KV + R2 + Vectorize index
npm run db:migrate:local             # applies migrations/0001_initial.sql + 0002_fts.sql
npm run dev                          # http://localhost:8787
```

Then open `http://localhost:8787/welcome` and create your first workspace. The page shows your owner API key once. Done.

### Deploy

```bash
wrangler login
npm run cf:bootstrap                 # idempotent
npm run db:migrate:remote
wrangler deploy
```

CI deploys on every push to `main` once tests pass (see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml)). It needs two repository secrets: `CLOUDFLARE_API_TOKEN` (a token with Workers + D1 + R2 + KV permissions) and `CLOUDFLARE_ACCOUNT_ID`.

### Seed sample data

```bash
NK_URL=https://nakatomi-crm.example.workers.dev \
NK_EMAIL=you@example.com NK_PASSWORD=verylongpassword \
NK_WORKSPACE_SLUG=acme NK_WORKSPACE_NAME=Acme \
node scripts/seed.mjs
```

The script uses `/welcome` on a fresh deploy and `/auth/login` on existing ones, then provisions a default sales pipeline + a sample company/contact/deal.

## API surface

REST under `/v1/*`; MCP at `/mcp`. Same auth — workspace API keys (`Authorization: Bearer nk_…`) or user JWT (+ `X-Nakatomi-Workspace`).

```
/v1/workspaces        /v1/contacts         /v1/companies      /v1/pipelines
/v1/deals             /v1/products         /v1/activities     /v1/notes
/v1/tasks             /v1/custom-fields    /v1/relationships  /v1/timeline
/v1/dashboard         /v1/files            /v1/ingest         /v1/exports
/v1/webhooks          /v1/memory           /v1/email          /v1/calendar
/mcp                  /oauth/*             /welcome           /healthz /readyz
/.well-known/oauth-authorization-server   /.well-known/oauth-protected-resource
/.well-known/agent.json                   /llms.txt
```

## Auth

Three flavors, all on the same `requireAuth` path:

1. **API key** (agents): `Authorization: Bearer nk_<prefix>_<secret>`. Workspace inferred from the key. Mint via `POST /workspace/api-keys` (owner/admin).
2. **JWT** (humans, scripts): `POST /auth/signup` or `POST /auth/login` → bearer token. Send `Authorization: Bearer <jwt>` and `X-Nakatomi-Workspace: <slug-or-id>`.
3. **OAuth 2.1 + PKCE** (MCP clients): Claude Desktop, Cursor, ChatGPT Custom Connectors all do dynamic registration → authorize → token. Access tokens are issued as API keys, so requireAuth treats them identically.

## MCP

- Endpoint: `https://<host>/mcp` (streamable HTTP)
- Auth: `Authorization: Bearer nk_<key>` (or an OAuth-issued access token)
- 21 tools wrap the REST surface: contact/company/deal/pipeline CRUD, deal stage moves, activity/note/task creation, relationship edges, timeline reads, memory recall/link/trace, send_email, sync_calendar_feed, dashboard_summary.

See [`src/mcp/tools.ts`](./src/mcp/tools.ts) for the full registry with inputSchemas.

## Tests

106 passing across 19 suites. Stack: Vitest + `@cloudflare/vitest-pool-workers` against a real miniflare D1 + R2 + KV.

```
auth                15   contacts         8   companies          3
deals                3   line items       3   pipelines          4
products             2   touchpoints      6   schema             6
workspaces           4   files            4   ingest-export      5
oauth                8   webhooks         6   memory             4
graph-dashboard      5   email-calendar   6   mcp                7   welcome   4
```

> **Local test note:** `@cloudflare/vitest-pool-workers` + miniflare currently mishandles project paths that contain spaces. If your checkout is under e.g. `~/Claude Repo/…`, copy into a space-free directory before `npm test`. CI runs on a clean path so it's unaffected.

## Trade-offs

- **No raw IMAP/SMTP.** Outbound email uses Resend (HTTPS). Inbound lands via Cloudflare Email Routing's Worker email handler. Legacy IMAP/SMTP can't run on Workers.
- **Decimal-as-text.** D1/SQLite has no DECIMAL type. Money columns use Drizzle `numeric` (TEXT-backed) so the wire format matches legacy. Convert at the response layer when you need arithmetic.
- **Idempotency in KV.** Legacy stored `idempotency_keys` as a Postgres table; the new stack uses the KV `IDEMPOTENCY` namespace with TTL — same semantics, atomic on the read-modify-write boundary.
- **FTS5 instead of pg_trgm.** Contacts/companies/notes/deals get an FTS5 virtual table kept in sync by triggers. Search syntax is FTS5 MATCH; identical UX to the legacy fuzzy search.

## License

MIT. See [LICENSE](./LICENSE).
