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
    body: JSON.stringify({ first_name: 'A', last_name: 'B', email: 'a@b.com' }),
  })
  return ((await r.json()) as { id: string }).id
}

describe('activities', () => {
  it('logs a call activity against a contact and filters by entity', async () => {
    const ctx = await signup()
    const contactId = await newContact(ctx)

    const create = await SELF.fetch('http://localhost/v1/activities', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'call',
        subject: 'intro call',
        body: 'discovery call about pricing',
        entity_type: 'contact',
        entity_id: contactId,
      }),
    })
    expect(create.status).toBe(201)

    const list = await SELF.fetch(
      `http://localhost/v1/activities?entity_type=contact&entity_id=${contactId}`,
      { headers: authHeaders(ctx) },
    )
    const body = (await list.json()) as { items: Array<{ kind: string; subject: string }> }
    expect(body.items.length).toBe(1)
    expect(body.items[0]!.kind).toBe('call')
  })

  it('filters by kind and date range', async () => {
    const ctx = await signup()
    await SELF.fetch('http://localhost/v1/activities', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'call', subject: 'A' }),
    })
    await SELF.fetch('http://localhost/v1/activities', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'meeting', subject: 'B' }),
    })
    const r = await SELF.fetch('http://localhost/v1/activities?kind=meeting', {
      headers: authHeaders(ctx),
    })
    const body = (await r.json()) as { items: unknown[] }
    expect(body.items.length).toBe(1)
  })
})

describe('notes', () => {
  it('attaches to an entity and round-trips FTS search', async () => {
    const ctx = await signup()
    const contactId = await newContact(ctx)

    const create = await SELF.fetch('http://localhost/v1/notes', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'contact',
        entity_id: contactId,
        body: 'They prefer Slack over email. Their procurement is slow.',
      }),
    })
    expect(create.status).toBe(201)

    const search = await SELF.fetch('http://localhost/v1/notes?q=procurement', {
      headers: authHeaders(ctx),
    })
    const body = (await search.json()) as { items: unknown[] }
    expect(body.items.length).toBe(1)
  })

  it('rejects body that is empty', async () => {
    const ctx = await signup()
    const contactId = await newContact(ctx)
    const r = await SELF.fetch('http://localhost/v1/notes', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ entity_type: 'contact', entity_id: contactId, body: '' }),
    })
    expect(r.status).toBe(400)
  })
})

describe('tasks', () => {
  it('creates, lists, completes, and surfaces overdue', async () => {
    const ctx = await signup()
    const contactId = await newContact(ctx)

    // overdue task
    const overdue = await SELF.fetch('http://localhost/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'follow up',
        entity_type: 'contact',
        entity_id: contactId,
        due_at: new Date(Date.now() - 86_400_000).toISOString(),
      }),
    })
    const oId = ((await overdue.json()) as { id: string }).id

    // future task
    await SELF.fetch('http://localhost/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'later',
        due_at: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    })

    const od = await SELF.fetch('http://localhost/v1/tasks?overdue=true', {
      headers: authHeaders(ctx),
    })
    const body = (await od.json()) as { items: Array<{ id: string; title: string }> }
    expect(body.items.length).toBe(1)
    expect(body.items[0]!.title).toBe('follow up')

    // complete via the sugar endpoint
    const done = await SELF.fetch(`http://localhost/v1/tasks/${oId}/complete`, {
      method: 'POST',
      headers: authHeaders(ctx),
    })
    expect(done.status).toBe(200)
    const doneBody = (await done.json()) as Record<string, unknown>
    expect(doneBody.status).toBe('done')
    expect(doneBody.completed_at).toBeTruthy()

    // overdue list now empty (completed tasks excluded)
    const od2 = await SELF.fetch('http://localhost/v1/tasks?overdue=true', {
      headers: authHeaders(ctx),
    })
    expect(((await od2.json()) as { items: unknown[] }).items.length).toBe(0)
  })

  it('clears completed_at when status flips back to open', async () => {
    const ctx = await signup()
    const create = await SELF.fetch('http://localhost/v1/tasks', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 't1' }),
    })
    const id = ((await create.json()) as { id: string }).id

    await SELF.fetch(`http://localhost/v1/tasks/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    })
    await SELF.fetch(`http://localhost/v1/tasks/${id}`, {
      method: 'PATCH',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'open' }),
    })

    const after = await SELF.fetch(`http://localhost/v1/tasks/${id}`, {
      headers: authHeaders(ctx),
    })
    expect(((await after.json()) as Record<string, unknown>).completed_at).toBeNull()
  })
})
