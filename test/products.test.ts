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

async function create(
  ctx: Awaited<ReturnType<typeof signup>>,
  body: Record<string, unknown>,
) {
  const res = await SELF.fetch('http://localhost/v1/products', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

describe('products', () => {
  it('CRUD with SKU', async () => {
    const ctx = await signup()
    const { res, json } = await create(ctx, {
      name: 'Widget',
      sku: 'WIDG-001',
      unit_price: '99.99',
      currency: 'USD',
    })
    expect(res.status).toBe(201)
    expect(json.sku).toBe('WIDG-001')
    expect(json.unit_price).toBe('99.99')

    const dup = await create(ctx, { name: 'Other', sku: 'WIDG-001' })
    expect(dup.res.status).toBe(409)
  })

  it('filters by sku and is_active', async () => {
    const ctx = await signup()
    await create(ctx, { name: 'A', sku: 'A-1' })
    await create(ctx, { name: 'B', sku: 'B-1', is_active: false })

    const r1 = await SELF.fetch('http://localhost/v1/products?sku=A-1', {
      headers: authHeaders(ctx),
    })
    expect(((await r1.json()) as { items: unknown[] }).items.length).toBe(1)

    const r2 = await SELF.fetch('http://localhost/v1/products?is_active=false', {
      headers: authHeaders(ctx),
    })
    expect(((await r2.json()) as { items: unknown[] }).items.length).toBe(1)
  })
})
