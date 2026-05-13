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

const DEFAULT_PIPELINE = {
  name: 'Sales',
  slug: 'sales',
  is_default: true,
  stages: [
    { name: 'New', slug: 'new', position: 0, probability: 10 },
    { name: 'Qualified', slug: 'qualified', position: 1, probability: 40 },
    { name: 'Won', slug: 'won', position: 2, probability: 100, is_won: true },
    { name: 'Lost', slug: 'lost', position: 3, probability: 0, is_lost: true },
  ],
}

describe('pipelines', () => {
  it('creates a pipeline with stages atomically', async () => {
    const ctx = await signup()
    const res = await SELF.fetch('http://localhost/v1/pipelines', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify(DEFAULT_PIPELINE),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { stages: unknown[] }
    expect(body.stages.length).toBe(4)
  })

  it('lists pipelines with their stages, ordered by position', async () => {
    const ctx = await signup()
    await SELF.fetch('http://localhost/v1/pipelines', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify(DEFAULT_PIPELINE),
    })
    const r = await SELF.fetch('http://localhost/v1/pipelines', { headers: authHeaders(ctx) })
    const body = (await r.json()) as { items: Array<{ stages: Array<{ position: number }> }> }
    expect(body.items.length).toBe(1)
    const positions = body.items[0]!.stages.map((s) => s.position)
    expect(positions).toEqual([0, 1, 2, 3])
  })

  it('rejects duplicate slug within a workspace', async () => {
    const ctx = await signup()
    await SELF.fetch('http://localhost/v1/pipelines', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify(DEFAULT_PIPELINE),
    })
    const dup = await SELF.fetch('http://localhost/v1/pipelines', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ ...DEFAULT_PIPELINE, name: 'Sales 2' }),
    })
    expect(dup.status).toBe(409)
  })

  it('adds, updates, and deletes a single stage on an existing pipeline', async () => {
    const ctx = await signup()
    const created = await SELF.fetch('http://localhost/v1/pipelines', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify(DEFAULT_PIPELINE),
    })
    const pipeline = (await created.json()) as { id: string }

    // add
    const add = await SELF.fetch(`http://localhost/v1/pipelines/${pipeline.id}/stages`, {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Negotiation',
        slug: 'negotiation',
        position: 2,
        probability: 70,
      }),
    })
    expect(add.status).toBe(201)
    const stage = (await add.json()) as { id: string }

    // update
    const upd = await SELF.fetch(
      `http://localhost/v1/pipelines/${pipeline.id}/stages/${stage.id}`,
      {
        method: 'PATCH',
        headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
        body: JSON.stringify({ probability: 80 }),
      },
    )
    expect(upd.status).toBe(200)
    expect(((await upd.json()) as Record<string, unknown>).probability).toBe('80')

    // delete
    const del = await SELF.fetch(
      `http://localhost/v1/pipelines/${pipeline.id}/stages/${stage.id}`,
      { method: 'DELETE', headers: authHeaders(ctx) },
    )
    expect(del.status).toBe(204)
  })
})
