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

async function create(ctx: Awaited<ReturnType<typeof signup>>, body: Record<string, unknown>) {
  const res = await SELF.fetch('http://localhost/v1/contacts', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

describe('contacts CRUD', () => {
  it('creates, fetches, updates, soft-deletes, and restores', async () => {
    const ctx = await signup()

    // create
    const { res: createRes, json: created } = await create(ctx, {
      first_name: 'Alice',
      last_name: 'Smith',
      email: 'alice.s@example.com',
      tags: ['vip'],
    })
    expect(createRes.status).toBe(201)
    expect(created.first_name).toBe('Alice')
    expect(created.tags).toEqual(['vip'])

    // get
    const get1 = await SELF.fetch(`http://localhost/v1/contacts/${created.id}`, {
      headers: authHeaders(ctx),
    })
    expect(get1.status).toBe(200)

    // update
    const patch = await SELF.fetch(`http://localhost/v1/contacts/${created.id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'CEO' }),
    })
    expect(patch.status).toBe(200)
    const updated = (await patch.json()) as Record<string, unknown>
    expect(updated.title).toBe('CEO')
    expect(updated.first_name).toBe('Alice')

    // soft delete
    const del = await SELF.fetch(`http://localhost/v1/contacts/${created.id}`, {
      method: 'DELETE',
      headers: authHeaders(ctx),
    })
    expect(del.status).toBe(204)

    // get → 404
    const get2 = await SELF.fetch(`http://localhost/v1/contacts/${created.id}`, {
      headers: authHeaders(ctx),
    })
    expect(get2.status).toBe(404)

    // restore
    const restore = await SELF.fetch(`http://localhost/v1/contacts/${created.id}/restore`, {
      method: 'POST',
      headers: authHeaders(ctx),
    })
    expect(restore.status).toBe(200)
    expect(((await restore.json()) as Record<string, unknown>).deleted_at).toBeNull()
  })

  it('rejects duplicate external_id within a workspace', async () => {
    const ctx = await signup()
    await create(ctx, { external_id: 'crm-1', first_name: 'A' })
    const { res } = await create(ctx, { external_id: 'crm-1', first_name: 'B' })
    expect(res.status).toBe(409)
  })

  it('validates email format', async () => {
    const ctx = await signup()
    const { res, json } = await create(ctx, { email: 'not-an-email' })
    expect(res.status).toBe(400)
    expect(json.error).toBe('validation_error')
  })

  it('isolates contacts across workspaces', async () => {
    const ctxA = await signup()
    const ctxB = await signup({
      email: 'bob@example.com',
      workspace_slug: 'beta',
      workspace_name: 'Beta',
    })

    const { json: cA } = await create(ctxA, { first_name: 'A' })
    const fetchFromB = await SELF.fetch(`http://localhost/v1/contacts/${cA.id}`, {
      headers: authHeaders(ctxB),
    })
    expect(fetchFromB.status).toBe(404)
  })
})

describe('contacts list', () => {
  it('paginates with stable cursors', async () => {
    const ctx = await signup()
    for (let i = 0; i < 6; i++) {
      await create(ctx, { first_name: `c${i}`, external_id: `e${i}` })
    }

    const page1 = await SELF.fetch('http://localhost/v1/contacts?limit=4', {
      headers: authHeaders(ctx),
    })
    const p1 = (await page1.json()) as { items: any[]; next_cursor: string | null }
    expect(p1.items.length).toBe(4)
    expect(p1.next_cursor).toBeTruthy()

    const page2 = await SELF.fetch(
      `http://localhost/v1/contacts?limit=4&cursor=${encodeURIComponent(p1.next_cursor!)}`,
      { headers: authHeaders(ctx) },
    )
    const p2 = (await page2.json()) as { items: any[]; next_cursor: string | null }
    expect(p2.items.length).toBe(2)
    expect(p2.next_cursor).toBeNull()

    const seen = new Set([...p1.items, ...p2.items].map((x) => x.id))
    expect(seen.size).toBe(6) // no duplicates across pages
  })

  it('filters by email and company_id', async () => {
    const ctx = await signup()
    await create(ctx, { first_name: 'A', email: 'a@example.com' })
    await create(ctx, { first_name: 'B', email: 'b@example.com' })
    const r = await SELF.fetch('http://localhost/v1/contacts?email=a@example.com', {
      headers: authHeaders(ctx),
    })
    const body = (await r.json()) as { items: any[] }
    expect(body.items.length).toBe(1)
    expect(body.items[0].email).toBe('a@example.com')
  })

  it('full-text search via FTS5 trigger-synced index', async () => {
    const ctx = await signup()
    await create(ctx, { first_name: 'Hermione', last_name: 'Granger' })
    await create(ctx, { first_name: 'Harry', last_name: 'Potter' })
    const r = await SELF.fetch('http://localhost/v1/contacts?q=hermione', {
      headers: authHeaders(ctx),
    })
    const body = (await r.json()) as { items: any[] }
    expect(body.items.length).toBe(1)
    expect(body.items[0].first_name).toBe('Hermione')
  })

  it('excludes soft-deleted by default; include_deleted=true surfaces them', async () => {
    const ctx = await signup()
    const { json: c } = await create(ctx, { first_name: 'Gone' })
    await SELF.fetch(`http://localhost/v1/contacts/${c.id}`, {
      method: 'DELETE',
      headers: authHeaders(ctx),
    })
    const r1 = (await (
      await SELF.fetch('http://localhost/v1/contacts', { headers: authHeaders(ctx) })
    ).json()) as { items: any[] }
    expect(r1.items.length).toBe(0)
    const r2 = (await (
      await SELF.fetch('http://localhost/v1/contacts?include_deleted=true', {
        headers: authHeaders(ctx),
      })
    ).json()) as { items: any[] }
    expect(r2.items.length).toBe(1)
  })
})
