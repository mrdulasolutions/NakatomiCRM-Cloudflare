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

async function newContact(ctx: Awaited<ReturnType<typeof signup>>): Promise<string> {
  const r = await SELF.fetch('http://localhost/v1/contacts', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'A' }),
  })
  return ((await r.json()) as { id: string }).id
}

describe('memory connectors', () => {
  it('lists configured connectors (none in this test env)', async () => {
    const ctx = await signup()
    const res = await SELF.fetch('http://localhost/v1/memory/connectors', {
      headers: authHeaders(ctx),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as { items: string[] }).toEqual({ items: [] })
  })

  it('recall returns empty when no connectors configured', async () => {
    const ctx = await signup()
    const res = await SELF.fetch('http://localhost/v1/memory/recall', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'anything' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[] }
    expect(body.items).toEqual([])
  })
})

describe('memory links', () => {
  it('create + trace + list + delete with dedup', async () => {
    const ctx = await signup()
    const contactId = await newContact(ctx)

    const create = await SELF.fetch('http://localhost/v1/memory/link', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        connector: 'docdeploy',
        external_id: 'memo-1',
        crm_entity_type: 'contact',
        crm_entity_id: contactId,
        note: 'first email exchange',
      }),
    })
    expect(create.status).toBe(201)
    const link = (await create.json()) as { id: string }

    // Duplicate edge → 409
    const dup = await SELF.fetch('http://localhost/v1/memory/link', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        connector: 'docdeploy',
        external_id: 'memo-1',
        crm_entity_type: 'contact',
        crm_entity_id: contactId,
      }),
    })
    expect(dup.status).toBe(409)

    // Trace
    const trace = await SELF.fetch(`http://localhost/v1/memory/trace/contact/${contactId}`, {
      headers: authHeaders(ctx),
    })
    const traceBody = (await trace.json()) as { items: unknown[] }
    expect(traceBody.items.length).toBe(1)

    // Connector-filtered list
    const list = await SELF.fetch('http://localhost/v1/memory/links?connector=docdeploy', {
      headers: authHeaders(ctx),
    })
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(1)

    // Delete
    const del = await SELF.fetch(`http://localhost/v1/memory/link/${link.id}`, {
      method: 'DELETE',
      headers: authHeaders(ctx),
    })
    expect(del.status).toBe(204)
  })

  it('emits memory.linked timeline event on creation', async () => {
    const ctx = await signup()
    const contactId = await newContact(ctx)

    await SELF.fetch('http://localhost/v1/memory/link', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        connector: 'supermemory',
        external_id: 'sm-42',
        crm_entity_type: 'contact',
        crm_entity_id: contactId,
      }),
    })

    const events = await SELF.fetch(
      `http://localhost/v1/timeline?entity_type=contact&entity_id=${contactId}`,
      { headers: authHeaders(ctx) },
    )
    const body = (await events.json()) as { items: Array<{ event_type: string }> }
    expect(body.items.some((e) => e.event_type === 'memory.linked')).toBe(true)
  })
})
