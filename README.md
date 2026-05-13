# Nakatomi CRM — Cloudflare edition

> A headless CRM built for AI agents, rebuilt on Cloudflare Workers. No UI to
> click. No email to sync. Just a clean structured API and an MCP server so
> Claude, ChatGPT, Cursor, and Perplexity can work with your CRM as a
> first-class tool — running at the edge, globally, with D1, R2, KV, Queues,
> Vectorize, and Workers AI underneath.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Workers](https://img.shields.io/badge/runtime-cloudflare%20workers-f38020.svg)](https://workers.cloudflare.com/)
[![Status](https://img.shields.io/badge/status-rebuilding-orange.svg)](#status)

## Status

This repository is a Cloudflare-native rewrite of
[NakatomiCRM](https://github.com/mrdulasolutions/NakatomiCRM) (FastAPI +
Postgres). The original Python code is preserved under [`legacy/`](./legacy)
as a read-only reference; new code lives at the root in TypeScript.

| Phase | Scope | State |
| --- | --- | --- |
| A.1 | Workers scaffold (Hono, wrangler, Vitest, env types) | in progress |
| A.2 | Drizzle schema port + D1 migrations | pending |
| A.3 | Auth (JWT + API keys + KV rate-limit) | pending |
| B   | Core CRUD routers (contacts, companies, deals, …) | pending |
| C   | Files (R2), exports, ingest | pending |
| D   | Webhooks via Queues, memory adapters, OAuth | pending |
| E   | Email + calendar (provider APIs, not raw TCP) | pending |
| F   | MCP server (streamable HTTP), welcome flow | pending |
| G   | CI → wrangler deploy, seed script, docs | pending |

## Why Cloudflare

| Concern | Old (Python on Railway) | New (Cloudflare) |
| --- | --- | --- |
| Compute | Single container | Workers, globally distributed |
| SQL | Postgres | D1 (SQLite at the edge) |
| Files | Local disk or S3 | R2 (zero-egress) |
| Sessions / cache | Postgres rows | KV |
| Webhook delivery | In-process worker | Queues + DLQ + Cron sweeper |
| Async ingest | Background task | Queues |
| Semantic memory | External adapter only | Vectorize + Workers AI |
| AI features (scoring, summaries) | External call | Workers AI |
| Scheduled work | APScheduler | Cron Triggers |
| Cold start | Container boot (~seconds) | ~0 ms |

## Cloudflare bindings

Declared in [`wrangler.toml`](./wrangler.toml):

| Binding | Resource | Used for |
| --- | --- | --- |
| `DB` | D1 | Primary SQL |
| `FILES` | R2 | Attachments, exports |
| `SESSIONS` | KV | JWT denylist, refresh state |
| `RATE_LIMIT` | KV | Per-key request buckets |
| `IDEMPOTENCY` | KV | `Idempotency-Key` dedup |
| `WEBHOOK_QUEUE` | Queue | Durable webhook delivery |
| `INGEST_QUEUE` | Queue | Async importer/ingest jobs |
| `VECTORS` | Vectorize | Semantic memory, dedup |
| `AI` | Workers AI | Embeddings, scoring, summaries |
| `ASSETS` | Static assets | Logos, welcome page |

## Quickstart (local)

```bash
npm install
cp .dev.vars.example .dev.vars       # then set JWT_SECRET
npm run cf:bootstrap                 # creates D1 + KV + R2 + queues + vectorize index
npm run db:migrate:local             # applies migrations to local D1
npm run dev                          # http://localhost:8787
```

## Deploy

```bash
wrangler login
npm run cf:bootstrap                 # idempotent; safe to re-run
npm run db:migrate:remote
wrangler deploy
```

The bootstrap script writes generated resource IDs back into
`wrangler.toml`. Commit the result.

## API surface (target)

Same as the legacy FastAPI app — full parity is the bar:

contacts · companies · deals · pipelines · products · activities · notes ·
tasks · files · custom_fields · relationships · timeline · dashboard ·
exports · ingest · webhooks · memory · oauth · email · calendar · forecast ·
welcome · workspaces · auth · `/mcp` · `/schema` · `/.well-known/agent.json`
· `llms.txt`

See [`legacy/app/routers`](./legacy/app/routers) for current behaviors and
[`legacy/docs`](./legacy/docs) for architecture notes carried forward.

## License

MIT. See [LICENSE](./LICENSE).
