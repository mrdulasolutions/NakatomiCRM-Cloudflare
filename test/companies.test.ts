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
  const res = await SELF.fetch('http://localhost/v1/companies', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

describe('companies', () => {
  it('CRUD round-trip', async () => {
    const ctx = await signup()
    const { res, json } = await create(ctx, {
      name: 'Acme Corp',
      domain: 'acme.example',
      industry: 'manufacturing',
      employee_count: 42,
      tags: ['enterprise'],
    })
    expect(res.status).toBe(201)
    expect(json.name).toBe('Acme Corp')

    const get1 = await SELF.fetch(`http://localhost/v1/companies/${json.id}`, {
      headers: authHeaders(ctx),
    })
    expect(get1.status).toBe(200)

    const patch = await SELF.fetch(`http://localhost/v1/companies/${json.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ industry: 'software' }),
    })
    expect(patch.status).toBe(200)
    const upd = (await patch.json()) as Record<string, unknown>
    expect(upd.industry).toBe('software')
    expect(upd.name).toBe('Acme Corp')

    const del = await SELF.fetch(`http://localhost/v1/companies/${json.id}`, {
      method: 'DELETE',
      headers: authHeaders(ctx),
    })
    expect(del.status).toBe(204)
  })

  it('requires name', async () => {
    const ctx = await signup()
    const { res } = await create(ctx, {})
    expect(res.status).toBe(400)
  })

  it('FTS search finds by name', async () => {
    const ctx = await signup()
    await create(ctx, { name: 'Stark Industries' })
    await create(ctx, { name: 'Wayne Enterprises' })
    const r = await SELF.fetch('http://localhost/v1/companies?q=stark', {
      headers: authHeaders(ctx),
    })
    const body = (await r.json()) as { items: Array<{ name: string }> }
    expect(body.items.length).toBe(1)
    expect(body.items[0]!.name).toBe('Stark Industries')
  })
})
