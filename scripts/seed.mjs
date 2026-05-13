#!/usr/bin/env node
/**
 * Seed a Nakatomi deployment with a starter workspace and sample data.
 *
 * Usage:
 *   NK_URL=https://nakatomi-crm.example.workers.dev \
 *   NK_EMAIL=you@example.com \
 *   NK_PASSWORD=verylongpassword \
 *   NK_WORKSPACE_SLUG=acme \
 *   NK_WORKSPACE_NAME=Acme \
 *   node scripts/seed.mjs
 *
 * Idempotent across re-runs of bullets that have natural keys
 * (external_id). The signup step itself is single-use — re-running
 * after bootstrap will surface 409s and bail.
 */

import process from 'node:process'

const URL_BASE = (process.env.NK_URL ?? 'http://localhost:8787').replace(/\/$/, '')
const EMAIL = process.env.NK_EMAIL ?? 'founder@example.com'
const PASSWORD = process.env.NK_PASSWORD ?? 'verylongpassword'
const SLUG = process.env.NK_WORKSPACE_SLUG ?? 'acme'
const WS_NAME = process.env.NK_WORKSPACE_NAME ?? 'Acme'

async function http(method, path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) }
  const res = await fetch(`${URL_BASE}${path}`, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!res.ok) {
    console.error(`${method} ${path} → HTTP ${res.status}:`, body)
    process.exit(1)
  }
  return body
}

console.log(`→ seeding ${URL_BASE}`)

// Try /welcome first (single-use). If 404 (already bootstrapped), fall
// through to /auth/login.
let token
const welcomeProbe = await fetch(`${URL_BASE}/welcome`)
if (welcomeProbe.status === 200) {
  console.log('  fresh deploy detected — using welcome bootstrap')
  const form = new URLSearchParams({
    email: EMAIL,
    password: PASSWORD,
    workspace_name: WS_NAME,
    workspace_slug: SLUG,
  })
  const r = await fetch(`${URL_BASE}/welcome`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!r.ok) {
    console.error(`welcome failed: HTTP ${r.status}`)
    process.exit(1)
  }
  const html = await r.text()
  const match = html.match(/nk_[A-Za-z0-9]{8}_[A-Za-z0-9]{43}/)
  if (!match) {
    console.error('could not extract API key from welcome page response')
    process.exit(1)
  }
  token = match[0]
  console.log(`  ✓ bootstrap complete. Save this API key (shown once):\n    ${token}`)
} else {
  console.log('  already bootstrapped — using /auth/login')
  const login = await http('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } })
  token = login.access_token
}

const authHeaders = {
  authorization: `Bearer ${token}`,
  'x-nakatomi-workspace': SLUG,
}

// Pipeline + stages
console.log('→ creating sales pipeline')
const pipelines = await http('GET', '/v1/pipelines', { headers: authHeaders })
if (pipelines.items.length === 0) {
  await http('POST', '/v1/pipelines', {
    headers: authHeaders,
    body: {
      name: 'Sales',
      slug: 'sales',
      is_default: true,
      stages: [
        { name: 'New', slug: 'new', position: 0, probability: 10 },
        { name: 'Qualified', slug: 'qualified', position: 1, probability: 40 },
        { name: 'Proposal', slug: 'proposal', position: 2, probability: 60 },
        { name: 'Won', slug: 'won', position: 3, probability: 100, is_won: true },
        { name: 'Lost', slug: 'lost', position: 4, probability: 0, is_lost: true },
      ],
    },
  })
}

// Sample company + contact + deal
console.log('→ creating sample records')
const company = await http('POST', '/v1/companies', {
  headers: authHeaders,
  body: { external_id: 'demo-co-1', name: 'Demo Industries', domain: 'demo.example' },
})
const contact = await http('POST', '/v1/contacts', {
  headers: authHeaders,
  body: {
    external_id: 'demo-c-1',
    first_name: 'Demo',
    last_name: 'Buyer',
    email: 'demo.buyer@demo.example',
    company_id: company.id,
  },
})
const deal = await http('POST', '/v1/deals', {
  headers: authHeaders,
  body: {
    name: 'Demo deal — Q3 expansion',
    amount: '25000.00',
    primary_contact_id: contact.id,
    company_id: company.id,
  },
})

console.log('→ done')
console.log(`   workspace: ${SLUG}`)
console.log(`   company  : ${company.id}`)
console.log(`   contact  : ${contact.id}`)
console.log(`   deal     : ${deal.id}`)
console.log()
console.log(`Try: curl -H 'Authorization: Bearer ${token}' ${URL_BASE}/v1/dashboard/summary`)
