import { and, eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { hashApiKey, looksLikeApiKey } from '../auth/api-key'
import { verifyAccessToken } from '../auth/jwt'
import { checkRateLimit } from '../auth/rate-limit'
import { makeDb } from '../db'
import {
  type ApiKey,
  type MemberRole,
  type User,
  type Workspace,
  apiKeys,
  memberships,
  users,
  workspaces,
} from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'

const DEFAULT_RATE_LIMIT_PER_MINUTE = 600
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface Principal {
  user: User | null
  apiKey: ApiKey | null
  workspace: Workspace
  role: MemberRole
  authKind: 'api_key' | 'jwt'
}

export type AppVars = { principal: Principal }
export type AuthedEnv = { Bindings: Env; Variables: AppVars }

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null
  const m = authHeader.match(/^Bearer\s+(.+)$/i)
  return m?.[1] ?? null
}

export const requireAuth: MiddlewareHandler<AuthedEnv> = async (c, next) => {
  const token = extractBearer(c.req.header('authorization'))
  if (!token) throw new HTTPError(401, 'missing bearer token')

  const db = makeDb(c.env.DB)
  const principal = looksLikeApiKey(token)
    ? await resolveApiKey(c, db, token)
    : await resolveJwt(c, db, token)

  c.set('principal', principal)
  await next()
}

async function resolveApiKey(
  c: Parameters<MiddlewareHandler<AuthedEnv>>[0],
  db: ReturnType<typeof makeDb>,
  token: string,
): Promise<Principal> {
  const hash = await hashApiKey(token)
  const key = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hash)).get()
  if (!key || key.revokedAt) throw new HTTPError(401, 'invalid api key')
  if (key.expiresAt && key.expiresAt.getTime() < Date.now()) {
    throw new HTTPError(401, 'api key expired')
  }

  const limit = key.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE
  const rl = await checkRateLimit(c.env.RATE_LIMIT, key.id, limit)
  if (!rl.ok) {
    throw new HTTPError(
      429,
      `rate limit exceeded (${limit}/min); retry in ${rl.retryAfter}s`,
      { 'Retry-After': String(rl.retryAfter) },
    )
  }

  // Fire-and-forget last_used_at bump — don't block the request on it.
  c.executionCtx.waitUntil(
    db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, key.id)).run(),
  )

  const ws = await db.select().from(workspaces).where(eq(workspaces.id, key.workspaceId)).get()
  if (!ws) throw new HTTPError(401, 'workspace not found')
  const user = key.userId
    ? ((await db.select().from(users).where(eq(users.id, key.userId)).get()) ?? null)
    : null
  return { user, apiKey: key, workspace: ws, role: key.role, authKind: 'api_key' }
}

async function resolveJwt(
  c: Parameters<MiddlewareHandler<AuthedEnv>>[0],
  db: ReturnType<typeof makeDb>,
  token: string,
): Promise<Principal> {
  const claims = await verifyAccessToken(c.env.JWT_SECRET, token)
  if (!claims) throw new HTTPError(401, 'invalid token')

  const user = await db.select().from(users).where(eq(users.id, claims.sub)).get()
  if (!user || !user.isActive) throw new HTTPError(401, 'user not found')

  const wsRef = c.req.header('x-nakatomi-workspace') ?? claims.ws
  if (!wsRef) {
    throw new HTTPError(401, 'X-Nakatomi-Workspace header required when using user tokens')
  }

  const ws = UUID_RE.test(wsRef)
    ? await db.select().from(workspaces).where(eq(workspaces.id, wsRef)).get()
    : await db.select().from(workspaces).where(eq(workspaces.slug, wsRef)).get()
  if (!ws) throw new HTTPError(401, 'workspace not found')

  const mem = await db
    .select()
    .from(memberships)
    .where(and(eq(memberships.workspaceId, ws.id), eq(memberships.userId, user.id)))
    .get()
  if (!mem) throw new HTTPError(403, 'not a member of this workspace')

  return { user, apiKey: null, workspace: ws, role: mem.role, authKind: 'jwt' }
}

export function requireRole(...allowed: MemberRole[]): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const p = c.var.principal
    if (!allowed.includes(p.role)) {
      throw new HTTPError(403, `requires one of: ${allowed.join(', ')}`)
    }
    await next()
  }
}
