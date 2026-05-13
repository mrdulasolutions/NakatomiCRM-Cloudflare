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
  const res = await SELF.fetch('http://localhost/v1/pipelines', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Sales',
      slug: 'sales',
      is_default: true,
      stages: [
        { name: 'New', slug: 'new', position: 0, probability: 10 },
        { name: 'Qualified', slug: 'qualified', position: 1, probability: 40 },
        { name: 'Won', slug: 'won', position: 2, probability: 100, is_won: true },
        { name: 'Lost', slug: 'lost', position: 3, probability: 0, is_lost: true },
      ],
    }),
  })
  return (await res.json()) as { id: string; stages: Array<{ id: string; slug: string }> }
}

describe('deals', () => {
  it('creates a deal in the default pipeline + first stage when nothing is specified', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    const res = await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Big Acme Deal', amount: '50000' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.name).toBe('Big Acme Deal')
    expect(body.status).toBe('open')
  })

  it('moves a deal to a Won stage and stamps closed_at + status', async () => {
    const ctx = await signup()
    const pipeline = await seedPipeline(ctx)
    const wonStage = pipeline.stages.find((s) => s.slug === 'won')!

    const createRes = await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Closer', amount: '12000' }),
    })
    const deal = (await createRes.json()) as { id: string }

    const moveRes = await SELF.fetch(`http://localhost/v1/deals/${deal.id}/move`, {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ stage_id: wonStage.id }),
    })
    expect(moveRes.status).toBe(200)
    const moved = (await moveRes.json()) as Record<string, unknown>
    expect(moved.status).toBe('won')
    expect(moved.closed_at).toBeTruthy()
  })

  it('FTS search on deal name', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Quarterly renewal — ACME EMEA' }),
    })
    await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Initech contract' }),
    })
    const r = await SELF.fetch('http://localhost/v1/deals?q=renewal', {
      headers: authHeaders(ctx),
    })
    const body = (await r.json()) as { items: Array<{ name: string }> }
    expect(body.items.length).toBe(1)
    expect(body.items[0]!.name).toContain('renewal')
  })
})

describe('line items', () => {
  it('snapshots name + unit_price from product on creation', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    const dealRes = await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Onboarding bundle' }),
    })
    const deal = (await dealRes.json()) as { id: string }

    const prodRes = await SELF.fetch('http://localhost/v1/products', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Setup fee', sku: 'SET-1', unit_price: '500.00' }),
    })
    const prod = (await prodRes.json()) as { id: string }

    const lineRes = await SELF.fetch(
      `http://localhost/v1/deals/${deal.id}/line-items`,
      {
        method: 'POST',
        headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
        body: JSON.stringify({ product_id: prod.id, quantity: '2' }),
      },
    )
    expect(lineRes.status).toBe(201)
    const line = (await lineRes.json()) as Record<string, unknown>
    expect(line.name).toBe('Setup fee')
    expect(line.unit_price).toBe('500.00')
    expect(line.quantity).toBe('2')

    // Listing returns one
    const list = await SELF.fetch(
      `http://localhost/v1/deals/${deal.id}/line-items`,
      { headers: authHeaders(ctx) },
    )
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(1)
  })

  it('accepts ad-hoc lines (no product) when name is provided', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    const dealRes = await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Custom build' }),
    })
    const deal = (await dealRes.json()) as { id: string }

    const lineRes = await SELF.fetch(
      `http://localhost/v1/deals/${deal.id}/line-items`,
      {
        method: 'POST',
        headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Discovery workshop', unit_price: '2500.00' }),
      },
    )
    expect(lineRes.status).toBe(201)
  })

  it('rejects ad-hoc lines without a name', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    const dealRes = await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    })
    const deal = (await dealRes.json()) as { id: string }
    const lineRes = await SELF.fetch(
      `http://localhost/v1/deals/${deal.id}/line-items`,
      {
        method: 'POST',
        headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
        body: JSON.stringify({ unit_price: '100' }),
      },
    )
    expect(lineRes.status).toBe(400)
  })
})
