import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { sha256B64Url } from '../src/lib/encoding'
import { resetDb, signup } from './helpers/auth'
import { applyMigrations } from './helpers/migrate'

beforeAll(async () => {
  await applyMigrations(env.DB)
})

beforeEach(async () => {
  await resetDb()
})

describe('OAuth discovery', () => {
  it('serves /.well-known/oauth-authorization-server', async () => {
    const res = await SELF.fetch('http://localhost/.well-known/oauth-authorization-server')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.code_challenge_methods_supported).toEqual(['S256'])
    expect(body.token_endpoint).toMatch(/\/oauth\/token$/)
  })

  it('serves /.well-known/oauth-protected-resource', async () => {
    const res = await SELF.fetch('http://localhost/.well-known/oauth-protected-resource')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.bearer_methods_supported).toEqual(['header'])
  })
})

describe('dynamic client registration', () => {
  it('issues a client_id', async () => {
    const res = await SELF.fetch('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude Desktop',
        redirect_uris: ['https://claude.ai/oauth/callback'],
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.client_id).toBeTruthy()
    expect(body.token_endpoint_auth_method).toBe('none')
  })

  it('rejects no redirect_uris', async () => {
    const res = await SELF.fetch('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'X' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('PKCE authorization code flow end-to-end', () => {
  it('register → authorize → token → access token works against a protected endpoint', async () => {
    await signup() // creates user alice@example.com / verylongpassword / workspace acme

    // 1) register
    const reg = await SELF.fetch('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test client',
        redirect_uris: ['https://test.example/callback'],
      }),
    })
    const client = (await reg.json()) as { client_id: string }

    // 2) PKCE: pick a verifier, derive a challenge
    const verifier = 'super-secure-test-verifier-1234567890abcdef'
    const challenge = await sha256B64Url(verifier)

    // 3) POST /oauth/authorize directly with creds — bypassing the
    // human-facing GET form to test the same code path.
    const authForm = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: 'https://test.example/callback',
      response_type: 'code',
      state: 'test-state',
      scope: 'mcp',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      email: 'alice@example.com',
      password: 'verylongpassword',
    })
    const auth = await SELF.fetch('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: authForm.toString(),
      redirect: 'manual',
    })
    expect(auth.status).toBe(302)
    const loc = auth.headers.get('location') ?? ''
    expect(loc).toMatch(/^https:\/\/test\.example\/callback\?code=/)
    const code = new URL(loc).searchParams.get('code')!

    // 4) exchange code for tokens
    const tokenRes = await SELF.fetch('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://test.example/callback',
        client_id: client.client_id,
        code_verifier: verifier,
      }).toString(),
    })
    expect(tokenRes.status).toBe(200)
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; expires_in: number }
    expect(tokens.access_token).toMatch(/^nk_/)
    expect(tokens.refresh_token).toMatch(/^nk_/)
    expect(tokens.expires_in).toBe(3600)

    // 5) use the access token to hit a protected endpoint
    const me = await SELF.fetch('http://localhost/auth/me', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    expect(me.status).toBe(200)
    const meBody = (await me.json()) as { auth_kind: string; workspace: { slug: string } }
    expect(meBody.auth_kind).toBe('api_key')
    expect(meBody.workspace.slug).toBe('acme')

    // 6) refresh_token grant rotates and revokes
    const refresh = await SELF.fetch('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }).toString(),
    })
    expect(refresh.status).toBe(200)
    const refreshed = (await refresh.json()) as { access_token: string; refresh_token: string }
    expect(refreshed.access_token).not.toBe(tokens.access_token)
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token)

    // Old refresh is now revoked
    const revokedAttempt = await SELF.fetch('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
      }).toString(),
    })
    expect(revokedAttempt.status).toBe(400)
  })

  it('PKCE mismatch is rejected at token exchange', async () => {
    await signup()
    const reg = await SELF.fetch('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'x', redirect_uris: ['https://test.example/cb'] }),
    })
    const client = (await reg.json()) as { client_id: string }
    const challenge = await sha256B64Url('the-real-verifier')

    const auth = await SELF.fetch('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'https://test.example/cb',
        response_type: 'code',
        state: '',
        scope: 'mcp',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        email: 'alice@example.com',
        password: 'verylongpassword',
      }).toString(),
      redirect: 'manual',
    })
    const code = new URL(auth.headers.get('location') ?? 'http://x/?code=').searchParams.get(
      'code',
    )!

    const tokenRes = await SELF.fetch('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://test.example/cb',
        client_id: client.client_id,
        code_verifier: 'WRONG-verifier',
      }).toString(),
    })
    expect(tokenRes.status).toBe(400)
    const body = (await tokenRes.json()) as { message: string }
    expect(body.message).toMatch(/PKCE/i)
  })

  it('rejects code reuse', async () => {
    await signup()
    const reg = await SELF.fetch('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'x', redirect_uris: ['https://test.example/cb'] }),
    })
    const client = (await reg.json()) as { client_id: string }
    const verifier = 'verifier-xyz-12345678'
    const challenge = await sha256B64Url(verifier)

    const auth = await SELF.fetch('http://localhost/oauth/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'https://test.example/cb',
        response_type: 'code',
        state: '',
        scope: 'mcp',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        email: 'alice@example.com',
        password: 'verylongpassword',
      }).toString(),
      redirect: 'manual',
    })
    const code = new URL(auth.headers.get('location') ?? 'http://x/?code=').searchParams.get(
      'code',
    )!

    const ok = await SELF.fetch('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://test.example/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      }).toString(),
    })
    expect(ok.status).toBe(200)

    const reuse = await SELF.fetch('http://localhost/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://test.example/cb',
        client_id: client.client_id,
        code_verifier: verifier,
      }).toString(),
    })
    expect(reuse.status).toBe(400)
  })
})

describe('login form', () => {
  it('GET /oauth/authorize renders an HTML form', async () => {
    const reg = await SELF.fetch('http://localhost/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'x', redirect_uris: ['https://test.example/cb'] }),
    })
    const { client_id } = (await reg.json()) as { client_id: string }
    const challenge = await sha256B64Url('verifier-form-test-1234')
    const url = new URL('http://localhost/oauth/authorize')
    url.searchParams.set('client_id', client_id)
    url.searchParams.set('redirect_uri', 'https://test.example/cb')
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('code_challenge', challenge)
    url.searchParams.set('code_challenge_method', 'S256')
    url.searchParams.set('scope', 'mcp')

    const res = await SELF.fetch(url.toString())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/html/)
    const html = await res.text()
    expect(html).toContain('<form')
    expect(html).toContain('Authorize')
  })
})
