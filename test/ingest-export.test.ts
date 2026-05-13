import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authHeaders, resetDb, signup } from './helpers/auth'
import { applyMigrations } from './helpers/migrate'

beforeAll(async () => {
  await applyMigrations(env.DB)
})

beforeEach(async () => {
  await resetDb()
})

async function seedPipeline(ctx: Awaited<ReturnType<typeof signup>>) {
  await SELF.fetch('http://localhost/v1/pipelines', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Sales',
      slug: 'sales',
      is_default: true,
      stages: [
        { name: 'New', slug: 'new', position: 0, probability: 10 },
        { name: 'Won', slug: 'won', position: 1, probability: 100, is_won: true },
      ],
    }),
  })
}

describe('ingest — JSON contacts', () => {
  it('creates new contacts and updates existing ones by external_id', async () => {
    const ctx = await signup()
    const first = await SELF.fetch('http://localhost/v1/ingest', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'salesforce-export',
        kind: 'contact',
        format: 'json',
        payload: [
          { external_id: 'sf-1', first_name: 'Alice', email: 'alice@x.com' },
          { external_id: 'sf-2', first_name: 'Bob', email: 'bob@x.com' },
        ],
      }),
    })
    expect(first.status).toBe(200)
    const body1 = (await first.json()) as {
      record_count: number
      created: number
      updated: number
      errors: number
    }
    expect(body1.record_count).toBe(2)
    expect(body1.created).toBe(2)
    expect(body1.updated).toBe(0)

    // Re-run with one update + one new
    const second = await SELF.fetch('http://localhost/v1/ingest', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'salesforce-export',
        kind: 'contact',
        format: 'json',
        payload: [
          { external_id: 'sf-1', first_name: 'Alice (updated)' },
          { external_id: 'sf-3', first_name: 'Carol', email: 'carol@x.com' },
        ],
      }),
    })
    const body2 = (await second.json()) as { created: number; updated: number }
    expect(body2.created).toBe(1)
    expect(body2.updated).toBe(1)

    const list = await SELF.fetch('http://localhost/v1/contacts', { headers: authHeaders(ctx) })
    const listBody = (await list.json()) as { items: Array<{ first_name: string }> }
    expect(listBody.items.length).toBe(3)
    expect(listBody.items.find((c) => c.first_name === 'Alice (updated)')).toBeTruthy()
  })
})

describe('ingest — CSV companies', () => {
  it('parses CSV with quoted fields and upserts by domain', async () => {
    const ctx = await signup()
    const csv = [
      'name,domain,industry,annual_revenue',
      '"Acme, Inc.",acme.example,Manufacturing,1500000.00',
      '"Initech",initech.com,"""Technology""",750000.00',
    ].join('\n')

    const r = await SELF.fetch('http://localhost/v1/ingest', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'crm-csv',
        kind: 'company',
        format: 'csv',
        payload: csv,
      }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { record_count: number; created: number; errors: number }
    expect(body.record_count).toBe(2)
    expect(body.created).toBe(2)
    expect(body.errors).toBe(0)
  })
})

describe('ingest — deals', () => {
  it('creates deals routing through stage_slug', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    const r = await SELF.fetch('http://localhost/v1/ingest', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'import',
        kind: 'deal',
        format: 'json',
        payload: [
          { external_id: 'd-1', name: 'Big deal', amount: '50000', stage_slug: 'new' },
          { external_id: 'd-2', name: 'Won deal', amount: '20000', stage_slug: 'won' },
        ],
      }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as { created: number; errors: number }
    expect(body.created).toBe(2)
    expect(body.errors).toBe(0)
  })

  it('errors with a clean diagnostic when no default pipeline exists', async () => {
    const ctx = await signup()
    const r = await SELF.fetch('http://localhost/v1/ingest', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'import',
        kind: 'deal',
        format: 'json',
        payload: [{ name: 'unrouted', amount: '1000' }],
      }),
    })
    const body = (await r.json()) as { errors: number; diagnostics: Array<{ message: string }> }
    expect(body.errors).toBe(1)
    expect(body.diagnostics[0]!.message).toMatch(/default pipeline/i)
  })
})

describe('exports', () => {
  it('owner-only; returns a JSON dump with counts', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    await SELF.fetch('http://localhost/v1/contacts', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'Alice' }),
    })

    const res = await SELF.fetch('http://localhost/v1/exports/workspace', {
      headers: authHeaders(ctx),
    })
    expect(res.status).toBe(200)
    const cd = res.headers.get('content-disposition') ?? ''
    expect(cd).toMatch(/^attachment; filename="nakatomi-acme-/)

    const body = (await res.json()) as {
      schema_version: number
      counts: Record<string, number>
      contacts: unknown[]
      pipelines: unknown[]
      webhooks: Array<{ secret: string }>
    }
    expect(body.schema_version).toBe(1)
    expect(body.contacts.length).toBe(1)
    expect(body.pipelines.length).toBe(1)
    expect(body.counts.contacts).toBe(1)
  })
})
