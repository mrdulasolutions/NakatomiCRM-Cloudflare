/**
 * OAuth 2.1 + PKCE provider for MCP clients.
 *
 * Endpoints implemented:
 *   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
 *   GET  /.well-known/oauth-protected-resource     RFC 9728 metadata
 *   POST /oauth/register                            RFC 7591 dynamic registration
 *   GET  /oauth/authorize                           login form
 *   POST /oauth/authorize                           validate, issue code, redirect
 *   POST /oauth/token                               authorization_code + refresh_token
 *   POST /oauth/revoke                              RFC 7009
 *
 * Access tokens are issued as `api_keys` rows (short-lived, expires_at ~1h)
 * so the existing requireAuth path checks them with no special casing.
 * Refresh tokens are also `api_keys` rows, with
 *   data: { oauth: { kind: 'refresh', client_id, scope } }
 * so the token endpoint can distinguish them.
 */

import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { generateApiKey, hashApiKey } from '../auth/api-key'
import { verifyPassword } from '../auth/password'
import { makeDb } from '../db'
import { apiKeys, memberships, oauthClients, oauthCodes, users, workspaces } from '../db/schema'
import type { Env } from '../env'
import { hexEncode, sha256B64Url, sha256Hex } from '../lib/encoding'
import { HTTPError } from '../lib/errors'

const CODE_TTL_SECONDS = 60
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 // 1h
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30 // 30d

function issuer(req: Request): string {
  const url = new URL(req.url)
  const proto = req.headers.get('x-forwarded-proto') ?? url.protocol.replace(':', '')
  const host = req.headers.get('x-forwarded-host') ?? url.host
  return `${proto}://${host}`
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

interface LoginRender {
  client_name: string
  client_id: string
  redirect_uri: string
  response_type: string
  state: string
  scope: string
  code_challenge: string
  code_challenge_method: string
  email?: string
  error?: string | null
  workspaces?: Array<{ id: string; name: string; slug: string }>
}

function renderLogin(r: LoginRender): string {
  const wsSelect =
    r.workspaces && r.workspaces.length > 1
      ? `<label>workspace</label><select name="workspace_id">${r.workspaces
          .map((w) => `<option value="${esc(w.id)}">${esc(w.name)} (${esc(w.slug)})</option>`)
          .join('')}</select>`
      : ''
  const err = r.error ? `<div class="err">${esc(r.error)}</div>` : ''
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Authorize · Nakatomi</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0d10; color: #e6e8ea; margin: 0; display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #11151a; border: 1px solid #20242a; border-radius: 12px; padding: 32px; width: 380px; max-width: 92vw; }
  h1 { font-size: 14px; letter-spacing: 2px; text-transform: uppercase; color: #6cf; margin: 0 0 6px 0; }
  p { color: #9ab; font-size: 12px; line-height: 1.55; margin: 0 0 20px 0; }
  .client { background: #0e1216; border: 1px solid #20242a; border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #e6e8ea; margin-bottom: 20px; }
  label { display: block; font-size: 11px; color: #9ab; margin-bottom: 6px; letter-spacing: 0.5px; text-transform: uppercase; margin-top: 14px; }
  input, select, button { font: inherit; width: 100%; padding: 10px 12px; background: #0b0d10; color: #e6e8ea; border: 1px solid #20242a; border-radius: 6px; box-sizing: border-box; }
  button { background: #1a2a3a; color: #6cf; cursor: pointer; margin-top: 20px; border-color: #2d3540; }
  button:hover { background: #223140; }
  .err { color: #ff8b8b; font-size: 11px; margin-top: 12px; padding: 8px 10px; background: #2a1212; border: 1px solid #4a2830; border-radius: 6px; }
  .scope { color: #7ee787; font-size: 11px; }
  .ft { color: #7a8590; font-size: 10px; margin-top: 18px; text-align: center; }
</style></head>
<body>
<form class="card" method="post" action="/oauth/authorize">
  <h1>Authorize</h1>
  <p>Grant <strong>${esc(r.client_name)}</strong> access to your Nakatomi workspace.</p>
  <div class="client">
    Requesting scope: <span class="scope">${esc(r.scope)}</span><br>
    Redirect: <span style="color:#9ab">${esc(r.redirect_uri)}</span>
  </div>
  <label>email</label>
  <input name="email" type="email" required autofocus value="${esc(r.email ?? '')}" />
  <label>password</label>
  <input name="password" type="password" required />
  ${wsSelect}
  ${err}
  <input type="hidden" name="client_id" value="${esc(r.client_id)}" />
  <input type="hidden" name="redirect_uri" value="${esc(r.redirect_uri)}" />
  <input type="hidden" name="response_type" value="${esc(r.response_type)}" />
  <input type="hidden" name="state" value="${esc(r.state)}" />
  <input type="hidden" name="scope" value="${esc(r.scope)}" />
  <input type="hidden" name="code_challenge" value="${esc(r.code_challenge)}" />
  <input type="hidden" name="code_challenge_method" value="${esc(r.code_challenge_method)}" />
  <button type="submit">Sign in &amp; authorize</button>
  <div class="ft">Nakatomi CRM · OAuth 2.1 + PKCE · Cloudflare Workers</div>
</form>
</body></html>`
}

async function issueTokens(
  db: ReturnType<typeof makeDb>,
  args: {
    userId: string
    workspaceId: string
    role: 'owner' | 'admin' | 'member' | 'readonly'
    clientId: string
    scope: string
  },
): Promise<{ access: string; refresh: string }> {
  const now = new Date()
  const access = await generateApiKey()
  const refresh = await generateApiKey()

  await db
    .insert(apiKeys)
    .values([
      {
        workspaceId: args.workspaceId,
        userId: args.userId,
        name: `oauth:${args.clientId.slice(0, 8)}:access`,
        prefix: access.prefix,
        keyHash: access.hash,
        role: args.role,
        expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
      },
      {
        workspaceId: args.workspaceId,
        userId: args.userId,
        name: `oauth:${args.clientId.slice(0, 8)}:refresh`,
        prefix: refresh.prefix,
        keyHash: refresh.hash,
        role: args.role,
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_SECONDS * 1000),
        data: { oauth: { kind: 'refresh', client_id: args.clientId, scope: args.scope } },
      },
    ])
    .run()

  return { access: access.full, refresh: refresh.full }
}

function tokenResponse(access: string, refresh: string, scope: string) {
  return {
    access_token: access,
    token_type: 'Bearer' as const,
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: refresh,
    scope,
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const oauthRouter = new Hono<{ Bindings: Env }>()

oauthRouter.get('/.well-known/oauth-authorization-server', (c) => {
  const iss = issuer(c.req.raw)
  return c.json({
    issuer: iss,
    authorization_endpoint: `${iss}/oauth/authorize`,
    token_endpoint: `${iss}/oauth/token`,
    revocation_endpoint: `${iss}/oauth/revoke`,
    registration_endpoint: `${iss}/oauth/register`,
    scopes_supported: ['mcp'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
  })
})

oauthRouter.get('/.well-known/oauth-protected-resource', (c) => {
  const iss = issuer(c.req.raw)
  return c.json({
    resource: iss,
    authorization_servers: [iss],
    scopes_supported: ['mcp'],
    bearer_methods_supported: ['header'],
  })
})

// ---- Registration ---------------------------------------------------------

const RegisterRequest = z.object({
  client_name: z.string().optional(),
  redirect_uris: z.array(z.string().url()).min(1),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  scope: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
})

oauthRouter.post('/oauth/register', async (c) => {
  const body = RegisterRequest.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const grants = body.grant_types ?? ['authorization_code', 'refresh_token']
  const responses = body.response_types ?? ['code']
  const scopes = (body.scope ?? 'mcp').split(/\s+/).filter(Boolean)

  const created = await db
    .insert(oauthClients)
    .values({
      name: body.client_name ?? 'Unnamed MCP client',
      redirectUris: body.redirect_uris,
      grantTypes: grants,
      responseTypes: responses,
      scopes,
    })
    .returning()
    .get()

  return c.json(
    {
      client_id: created.id,
      client_name: created.name,
      redirect_uris: created.redirectUris,
      grant_types: created.grantTypes,
      response_types: created.responseTypes,
      scope: scopes.join(' '),
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
    },
    201,
  )
})

// ---- Authorize endpoint ---------------------------------------------------

oauthRouter.get('/oauth/authorize', async (c) => {
  const params = new URL(c.req.url).searchParams
  const clientId = params.get('client_id') ?? ''
  const redirectUri = params.get('redirect_uri') ?? ''
  const responseType = params.get('response_type') ?? ''
  const codeChallenge = params.get('code_challenge') ?? ''
  const codeChallengeMethod = params.get('code_challenge_method') ?? 'S256'
  const state = params.get('state') ?? ''
  const scope = params.get('scope') ?? 'mcp'

  if (responseType !== 'code') throw new HTTPError(400, 'only response_type=code is supported')
  if (codeChallengeMethod !== 'S256') throw new HTTPError(400, 'only S256 PKCE is supported')

  const db = makeDb(c.env.DB)
  const client = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()
  if (!client || !(client.redirectUris as string[]).includes(redirectUri)) {
    throw new HTTPError(400, 'unknown client_id or redirect_uri not registered')
  }

  return c.html(
    renderLogin({
      client_name: client.name,
      client_id: client.id,
      redirect_uri: redirectUri,
      response_type: responseType,
      state,
      scope,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
    }),
  )
})

oauthRouter.post('/oauth/authorize', async (c) => {
  const form = await c.req.parseBody()
  const clientId = String(form.client_id ?? '')
  const redirectUri = String(form.redirect_uri ?? '')
  const responseType = String(form.response_type ?? 'code')
  const state = String(form.state ?? '')
  const scope = String(form.scope ?? 'mcp')
  const codeChallenge = String(form.code_challenge ?? '')
  const codeChallengeMethod = String(form.code_challenge_method ?? 'S256')
  const email = String(form.email ?? '').toLowerCase()
  const password = String(form.password ?? '')
  const workspaceId = form.workspace_id ? String(form.workspace_id) : null

  const db = makeDb(c.env.DB)
  const client = await db.select().from(oauthClients).where(eq(oauthClients.id, clientId)).get()
  if (!client || !(client.redirectUris as string[]).includes(redirectUri)) {
    throw new HTTPError(400, 'unknown client_id or redirect_uri not registered')
  }

  const renderArgs = {
    client_name: client.name,
    client_id: client.id,
    redirect_uri: redirectUri,
    response_type: responseType,
    state,
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    email,
  } satisfies LoginRender

  const user = await db.select().from(users).where(eq(users.email, email)).get()
  if (!user || !user.isActive || !(await verifyPassword(password, user.passwordHash))) {
    return c.html(renderLogin({ ...renderArgs, error: 'invalid email or password' }), 401)
  }

  const userMems = await db.select().from(memberships).where(eq(memberships.userId, user.id)).all()
  if (userMems.length === 0) {
    return c.html(renderLogin({ ...renderArgs, error: 'no workspaces — sign up first' }), 403)
  }

  let chosenWsId: string
  if (workspaceId) {
    if (!userMems.some((m) => m.workspaceId === workspaceId)) {
      throw new HTTPError(403, 'not a member of that workspace')
    }
    chosenWsId = workspaceId
  } else if (userMems.length === 1) {
    chosenWsId = userMems[0]!.workspaceId
  } else {
    const wsRows = await Promise.all(
      userMems.map((m) => db.select().from(workspaces).where(eq(workspaces.id, m.workspaceId)).get()),
    )
    const wsForRender = wsRows.filter((w): w is NonNullable<typeof w> => w !== undefined)
    return c.html(
      renderLogin({
        ...renderArgs,
        error: 'pick a workspace to authorize',
        workspaces: wsForRender.map((w) => ({ id: w.id, name: w.name, slug: w.slug })),
      }),
    )
  }

  // Mint a code (random urlsafe) and persist its sha256.
  const code = hexEncode(crypto.getRandomValues(new Uint8Array(48)))
  const codeHash = await sha256Hex(code)
  await db
    .insert(oauthCodes)
    .values({
      codeHash,
      clientId: client.id,
      userId: user.id,
      workspaceId: chosenWsId,
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      scope,
      expiresAt: new Date(Date.now() + CODE_TTL_SECONDS * 1000),
    })
    .run()

  const sep = redirectUri.includes('?') ? '&' : '?'
  let target = `${redirectUri}${sep}code=${encodeURIComponent(code)}`
  if (state) target += `&state=${encodeURIComponent(state)}`
  return c.redirect(target, 302)
})

// ---- Token endpoint -------------------------------------------------------

oauthRouter.post('/oauth/token', async (c) => {
  const form = await c.req.parseBody()
  const grantType = String(form.grant_type ?? '')
  const db = makeDb(c.env.DB)

  if (grantType === 'authorization_code') {
    const code = String(form.code ?? '')
    const redirectUri = String(form.redirect_uri ?? '')
    const clientId = String(form.client_id ?? '')
    const codeVerifier = String(form.code_verifier ?? '')
    if (!code || !redirectUri || !clientId || !codeVerifier) {
      throw new HTTPError(400, 'missing code / redirect_uri / client_id / code_verifier')
    }

    const codeHash = await sha256Hex(code)
    const row = await db.select().from(oauthCodes).where(eq(oauthCodes.codeHash, codeHash)).get()
    if (!row) throw new HTTPError(400, 'invalid or expired code')
    if (row.usedAt) throw new HTTPError(400, 'code already used')
    if (row.expiresAt.getTime() < Date.now()) throw new HTTPError(400, 'code expired')
    if (row.clientId !== clientId) throw new HTTPError(400, 'client_id mismatch')
    if (row.redirectUri !== redirectUri) throw new HTTPError(400, 'redirect_uri mismatch')

    // PKCE: S256(code_verifier) must match the stored challenge.
    const expectedChallenge = await sha256B64Url(codeVerifier)
    if (expectedChallenge !== row.codeChallenge) {
      throw new HTTPError(400, 'PKCE verification failed')
    }

    await db.update(oauthCodes).set({ usedAt: new Date() }).where(eq(oauthCodes.codeHash, codeHash)).run()

    const mem = await db
      .select()
      .from(memberships)
      .where(and(eq(memberships.userId, row.userId), eq(memberships.workspaceId, row.workspaceId)))
      .get()
    if (!mem) throw new HTTPError(403, 'user no longer a member')

    const { access, refresh } = await issueTokens(db, {
      userId: row.userId,
      workspaceId: row.workspaceId,
      role: mem.role,
      clientId: row.clientId,
      scope: row.scope,
    })
    return c.json(tokenResponse(access, refresh, row.scope))
  }

  if (grantType === 'refresh_token') {
    const refreshToken = String(form.refresh_token ?? '')
    if (!refreshToken) throw new HTTPError(400, 'refresh_token is required')
    const refreshHash = await hashApiKey(refreshToken)
    const key = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, refreshHash)).get()
    if (!key || key.revokedAt) throw new HTTPError(400, 'invalid refresh_token')
    const oauthData = (key.data as { oauth?: { kind?: string; client_id?: string; scope?: string } })
      .oauth
    if (!oauthData || oauthData.kind !== 'refresh') throw new HTTPError(400, 'not a refresh token')
    if (!key.userId) throw new HTTPError(400, 'refresh token has no user')

    // Rotate: revoke this refresh, mint a fresh pair.
    await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, key.id)).run()
    const { access, refresh } = await issueTokens(db, {
      userId: key.userId,
      workspaceId: key.workspaceId,
      role: key.role,
      clientId: oauthData.client_id ?? '',
      scope: oauthData.scope ?? 'mcp',
    })
    return c.json(tokenResponse(access, refresh, oauthData.scope ?? 'mcp'))
  }

  throw new HTTPError(400, `unsupported grant_type: ${grantType}`)
})

// ---- Revocation -----------------------------------------------------------

oauthRouter.post('/oauth/revoke', async (c) => {
  const form = await c.req.parseBody()
  const token = String(form.token ?? '')
  if (token) {
    const db = makeDb(c.env.DB)
    const hash = await hashApiKey(token)
    const row = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).get()
    if (row && !row.revokedAt) {
      await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, row.id)).run()
    }
  }
  // Always 200 per RFC 7009 to avoid leaking token existence.
  return c.json({ revoked: true })
})
