#!/usr/bin/env node
// Idempotent first-run bootstrap for Cloudflare resources.
//
// Creates (or no-ops if they already exist):
//   - D1 database "nakatomi-db"
//   - KV namespaces SESSIONS, RATE_LIMIT, IDEMPOTENCY
//   - R2 bucket "nakatomi-files"
//   - Queues "nakatomi-webhooks", "nakatomi-ingest" (+ DLQs)
//   - Vectorize index "nakatomi-memory"
//
// Then rewrites wrangler.toml placeholder IDs with the real ones.
//
// Requires: `wrangler login` and Node 20+.

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const TOML = 'wrangler.toml'

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim()
}

function tryJson(cmd) {
  try {
    return JSON.parse(sh(`${cmd} --json`))
  } catch {
    return null
  }
}

function ensureD1(name) {
  const list = tryJson('wrangler d1 list') ?? []
  const hit = list.find((d) => d.name === name)
  if (hit) return hit.uuid
  const out = sh(`wrangler d1 create ${name}`)
  const m = out.match(/database_id\s*=\s*"([^"]+)"/)
  if (!m) throw new Error(`could not parse d1 id:\n${out}`)
  return m[1]
}

function ensureKv(title) {
  const list = tryJson('wrangler kv namespace list') ?? []
  const hit = list.find((k) => k.title === title)
  if (hit) return hit.id
  const out = sh(`wrangler kv namespace create ${title}`)
  const m = out.match(/id\s*=\s*"([^"]+)"/)
  if (!m) throw new Error(`could not parse kv id:\n${out}`)
  return m[1]
}

function ensureR2(name) {
  const list = tryJson('wrangler r2 bucket list') ?? []
  if (list.find((b) => b.name === name)) return
  sh(`wrangler r2 bucket create ${name}`)
}

function ensureQueue(name) {
  const list = tryJson('wrangler queues list') ?? []
  if (list.find((q) => q.queue_name === name)) return
  sh(`wrangler queues create ${name}`)
}

function ensureVectorize(name) {
  const list = tryJson('wrangler vectorize list') ?? []
  if (list.find((v) => v.name === name)) return
  sh(`wrangler vectorize create ${name} --dimensions=768 --metric=cosine`)
}

function rewriteToml(replacements) {
  let toml = readFileSync(TOML, 'utf8')
  for (const [placeholder, value] of replacements) {
    toml = toml.replace(placeholder, value)
  }
  writeFileSync(TOML, toml)
}

const dbId = ensureD1('nakatomi-db')
const sessionsId = ensureKv('SESSIONS')
const rateLimitId = ensureKv('RATE_LIMIT')
const idempotencyId = ensureKv('IDEMPOTENCY')
ensureR2('nakatomi-files')
ensureQueue('nakatomi-webhooks')
ensureQueue('nakatomi-webhooks-dlq')
ensureQueue('nakatomi-ingest')
ensureQueue('nakatomi-ingest-dlq')
ensureVectorize('nakatomi-memory')

rewriteToml([
  ['PLACEHOLDER_RUN_npm_run_cf:bootstrap', dbId],
  ['PLACEHOLDER_KV_SESSIONS', sessionsId],
  ['PLACEHOLDER_KV_RATE_LIMIT', rateLimitId],
  ['PLACEHOLDER_KV_IDEMPOTENCY', idempotencyId],
])

console.log('\n✓ Cloudflare resources ready. Commit the updated wrangler.toml.')
