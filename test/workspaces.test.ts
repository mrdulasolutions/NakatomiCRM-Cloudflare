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

describe('workspaces', () => {
  it('GET /v1/workspaces/current returns the active workspace', async () => {
    const ctx = await signup()
    const res = await SELF.fetch('http://localhost/v1/workspaces/current', {
      headers: authHeaders(ctx),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.slug).toBe('acme')
  })

  it('PATCH /v1/workspaces/current updates the name (owner allowed)', async () => {
    const ctx = await signup()
    const res = await SELF.fetch('http://localhost/v1/workspaces/current', {
      method: 'PATCH',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Inc.' }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as Record<string, unknown>).name).toBe('Acme Inc.')
  })

  it('GET /v1/workspaces/current/members lists the owner', async () => {
    const ctx = await signup()
    const res = await SELF.fetch('http://localhost/v1/workspaces/current/members', {
      headers: authHeaders(ctx),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: Array<{ email: string; role: string }> }
    expect(body.items.length).toBe(1)
    expect(body.items[0]!.email).toBe('alice@example.com')
    expect(body.items[0]!.role).toBe('owner')
  })

  it('requires auth', async () => {
    const res = await SELF.fetch('http://localhost/v1/workspaces/current')
    expect(res.status).toBe(401)
  })
})
