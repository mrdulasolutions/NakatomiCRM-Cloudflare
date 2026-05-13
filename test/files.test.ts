import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authHeaders, resetDb, signup } from './helpers/auth'
import { applyMigrations } from './helpers/migrate'

beforeAll(async () => {
  await applyMigrations(env.DB)
})

beforeEach(async () => {
  await resetDb()
  // Clear any leftover R2 objects from previous test
  const list = await env.FILES.list()
  for (const obj of list.objects) await env.FILES.delete(obj.key)
})

async function upload(
  ctx: Awaited<ReturnType<typeof signup>>,
  filename: string,
  body: string,
  extra: Record<string, string> = {},
): Promise<{ res: Response; json: Record<string, unknown> }> {
  const form = new FormData()
  form.append('file', new File([body], filename, { type: 'text/plain' }))
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const res = await SELF.fetch('http://localhost/v1/files', {
    method: 'POST',
    headers: authHeaders(ctx),
    body: form,
  })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

describe('files', () => {
  it('uploads, persists, lists, downloads, and deletes', async () => {
    const ctx = await signup()
    const { res, json } = await upload(ctx, 'hello.txt', 'hello cloudflare')
    expect(res.status).toBe(201)
    expect(json.filename).toBe('hello.txt')
    expect(json.content_type).toBe('text/plain')
    expect(json.size_bytes).toBe('hello cloudflare'.length)
    expect(json.sha256).toBeTruthy()

    const list = await SELF.fetch('http://localhost/v1/files', { headers: authHeaders(ctx) })
    const lb = (await list.json()) as { items: unknown[] }
    expect(lb.items.length).toBe(1)

    const dl = await SELF.fetch(`http://localhost/v1/files/${json.id}/download`, {
      headers: authHeaders(ctx),
    })
    expect(dl.status).toBe(200)
    expect(await dl.text()).toBe('hello cloudflare')
    expect(dl.headers.get('content-type')).toBe('text/plain')

    const del = await SELF.fetch(`http://localhost/v1/files/${json.id}`, {
      method: 'DELETE',
      headers: authHeaders(ctx),
    })
    expect(del.status).toBe(204)

    const dl2 = await SELF.fetch(`http://localhost/v1/files/${json.id}/download`, {
      headers: authHeaders(ctx),
    })
    expect(dl2.status).toBe(404)
  })

  it('rejects upload without file field', async () => {
    const ctx = await signup()
    const form = new FormData()
    const res = await SELF.fetch('http://localhost/v1/files', {
      method: 'POST',
      headers: authHeaders(ctx),
      body: form,
    })
    expect(res.status).toBe(400)
  })

  it('attaches to an entity and shows up in the entity filter', async () => {
    const ctx = await signup()
    const contactRes = await SELF.fetch('http://localhost/v1/contacts', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ first_name: 'A' }),
    })
    const contactId = ((await contactRes.json()) as { id: string }).id

    await upload(ctx, 'spec.txt', 'spec', {
      entity_type: 'contact',
      entity_id: contactId,
    })

    const filtered = await SELF.fetch(
      `http://localhost/v1/files?entity_type=contact&entity_id=${contactId}`,
      { headers: authHeaders(ctx) },
    )
    expect(((await filtered.json()) as { items: unknown[] }).items.length).toBe(1)
  })

  it('isolates uploads across workspaces', async () => {
    const ctxA = await signup()
    const ctxB = await signup({
      email: 'b@x.com',
      workspace_slug: 'beta',
      workspace_name: 'Beta',
    })
    const { json: a } = await upload(ctxA, 'a.txt', 'a')
    const cross = await SELF.fetch(`http://localhost/v1/files/${a.id}/download`, {
      headers: authHeaders(ctxB),
    })
    expect(cross.status).toBe(404)
  })
})
