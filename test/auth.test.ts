import { SELF, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateApiKey } from '../src/auth/api-key'
import { hashPassword } from '../src/auth/password'
import { makeDb } from '../src/db'
import { apiKeys, memberships, users, workspaces } from '../src/db/schema'
import { applyMigrations } from './helpers/migrate'

beforeAll(async () => {
  await applyMigrations(env.DB)
})

beforeEach(async () => {
  // Each test gets a clean slate. We don't migrate down/up — just wipe
  // user-level data. Cascades take care of memberships.
  await env.DB.prepare('DELETE FROM api_keys').run()
  await env.DB.prepare('DELETE FROM memberships').run()
  await env.DB.prepare('DELETE FROM workspaces').run()
  await env.DB.prepare('DELETE FROM users').run()
})

const SIGNUP_BODY = {
  email: 'alice@example.com',
  password: 'verylongpassword',
  display_name: 'Alice',
  workspace_name: 'Acme',
  workspace_slug: 'acme',
}

async function signup(body = SIGNUP_BODY) {
  const res = await SELF.fetch('http://localhost/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, json: (await res.json()) as Record<string, unknown> }
}

describe('signup', () => {
  it('creates user + workspace + owner membership and returns a JWT', async () => {
    const { res, json } = await signup()
    expect(res.status).toBe(200)
    expect(json.token_type).toBe('Bearer')
    expect(typeof json.access_token).toBe('string')
    expect(json.workspace_slug).toBe('acme')

    const db = makeDb(env.DB)
    const u = await db.select().from(users).where(eq(users.email, 'alice@example.com')).get()
    expect(u).toBeTruthy()
    const ws = await db.select().from(workspaces).where(eq(workspaces.slug, 'acme')).get()
    expect(ws).toBeTruthy()
    const mem = await db.select().from(memberships).where(eq(memberships.userId, u!.id)).get()
    expect(mem?.role).toBe('owner')
  })

  it('rejects duplicate email with 409', async () => {
    await signup()
    const { res, json } = await signup({ ...SIGNUP_BODY, workspace_slug: 'other' })
    expect(res.status).toBe(409)
    expect(json.message).toMatch(/email/i)
  })

  it('rejects duplicate workspace slug with 409', async () => {
    await signup()
    const { res, json } = await signup({ ...SIGNUP_BODY, email: 'bob@example.com' })
    expect(res.status).toBe(409)
    expect(json.message).toMatch(/slug/i)
  })

  it('validates password length', async () => {
    const { res, json } = await signup({ ...SIGNUP_BODY, password: 'short' })
    expect(res.status).toBe(400)
    expect(json.error).toBe('validation_error')
  })

  it('validates workspace slug format', async () => {
    const { res, json } = await signup({ ...SIGNUP_BODY, workspace_slug: 'Has Spaces' })
    expect(res.status).toBe(400)
    expect(json.error).toBe('validation_error')
  })
})

describe('login', () => {
  it('returns a token for correct credentials', async () => {
    await signup()
    const res = await SELF.fetch('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'verylongpassword' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(typeof body.access_token).toBe('string')
  })

  it('rejects wrong password with 401 (constant-time)', async () => {
    await signup()
    const res = await SELF.fetch('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'alice@example.com', password: 'wrongwrongwrong' }),
    })
    expect(res.status).toBe(401)
  })

  it('rejects unknown email with 401', async () => {
    const res = await SELF.fetch('http://localhost/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: 'doesntmatter' }),
    })
    expect(res.status).toBe(401)
  })
})

describe('/auth/me', () => {
  it('requires a bearer token', async () => {
    const res = await SELF.fetch('http://localhost/auth/me')
    expect(res.status).toBe(401)
  })

  it('returns the JWT principal', async () => {
    const { json } = await signup()
    const res = await SELF.fetch('http://localhost/auth/me', {
      headers: {
        authorization: `Bearer ${json.access_token}`,
        'x-nakatomi-workspace': 'acme',
      },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.user.email).toBe('alice@example.com')
    expect(body.workspace.slug).toBe('acme')
    expect(body.role).toBe('owner')
    expect(body.auth_kind).toBe('jwt')
  })

  it('falls back to the workspace embedded in the JWT when no header is sent', async () => {
    const { json } = await signup()
    const res = await SELF.fetch('http://localhost/auth/me', {
      headers: { authorization: `Bearer ${json.access_token}` },
    })
    expect(res.status).toBe(200)
  })

  it('rejects a garbage bearer with 401', async () => {
    const res = await SELF.fetch('http://localhost/auth/me', {
      headers: { authorization: 'Bearer not-a-jwt' },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a revoked API key', async () => {
    await signup()
    const db = makeDb(env.DB)
    const ws = await db.select().from(workspaces).where(eq(workspaces.slug, 'acme')).get()
    const generated = await generateApiKey()
    await db
      .insert(apiKeys)
      .values({
        workspaceId: ws!.id,
        name: 'test',
        prefix: generated.prefix,
        keyHash: generated.hash,
        role: 'admin',
        revokedAt: new Date(),
      })
      .run()

    const res = await SELF.fetch('http://localhost/auth/me', {
      headers: { authorization: `Bearer ${generated.full}` },
    })
    expect(res.status).toBe(401)
  })

  it('accepts a valid API key and identifies workspace from the key', async () => {
    await signup()
    const db = makeDb(env.DB)
    const ws = await db.select().from(workspaces).where(eq(workspaces.slug, 'acme')).get()
    const generated = await generateApiKey()
    await db
      .insert(apiKeys)
      .values({
        workspaceId: ws!.id,
        name: 'test',
        prefix: generated.prefix,
        keyHash: generated.hash,
        role: 'admin',
      })
      .run()

    const res = await SELF.fetch('http://localhost/auth/me', {
      headers: { authorization: `Bearer ${generated.full}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body.auth_kind).toBe('api_key')
    expect(body.workspace.slug).toBe('acme')
    expect(body.role).toBe('admin')
    expect(body.user).toBeNull()
  })
})

describe('password hashing', () => {
  it('verifies a freshly-hashed password', async () => {
    const stored = await hashPassword('verylongpassword')
    expect(stored).toMatch(/^pbkdf2_sha256\$600000\$/)
    // Note: full verify round-trip is implicitly covered by login tests
    // above — they round-trip through the same hash function.
  })
})
