import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createAccessToken } from '../auth/jwt'
import { hashPassword, verifyPassword } from '../auth/password'
import { makeDb } from '../db'
import { memberships, users, workspaces } from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth } from '../middleware/auth'

const JWT_TTL_SECONDS = 60 * 60 * 24 * 7 // 7d

const SignupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(256),
  display_name: z.string().max(255).optional(),
  workspace_name: z.string().min(1).max(255),
  workspace_slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'workspace_slug must be lowercase alphanumeric or hyphen'),
})

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
})

interface TokenResponse {
  access_token: string
  token_type: 'Bearer'
  expires_in_seconds: number
  user_id: string
  workspace_id: string
  workspace_slug: string
}

export const authRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()

authRouter.post('/signup', async (c) => {
  const body = SignupSchema.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const email = body.email.toLowerCase()

  if (await db.select().from(users).where(eq(users.email, email)).get()) {
    throw new HTTPError(409, 'email already registered')
  }
  if (await db.select().from(workspaces).where(eq(workspaces.slug, body.workspace_slug)).get()) {
    throw new HTTPError(409, 'workspace slug taken')
  }

  const passwordHash = await hashPassword(body.password)
  const user = await db
    .insert(users)
    .values({ email, passwordHash, displayName: body.display_name })
    .returning()
    .get()
  const ws = await db
    .insert(workspaces)
    .values({ name: body.workspace_name, slug: body.workspace_slug })
    .returning()
    .get()
  await db
    .insert(memberships)
    .values({ workspaceId: ws.id, userId: user.id, role: 'owner' })
    .run()

  const access_token = await createAccessToken(
    c.env.JWT_SECRET,
    { sub: user.id, ws: ws.id },
    JWT_TTL_SECONDS,
  )
  const res: TokenResponse = {
    access_token,
    token_type: 'Bearer',
    expires_in_seconds: JWT_TTL_SECONDS,
    user_id: user.id,
    workspace_id: ws.id,
    workspace_slug: ws.slug,
  }
  return c.json(res)
})

authRouter.post('/login', async (c) => {
  const body = LoginSchema.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const email = body.email.toLowerCase()

  const user = await db.select().from(users).where(eq(users.email, email)).get()
  if (!user || !user.isActive || !(await verifyPassword(body.password, user.passwordHash))) {
    throw new HTTPError(401, 'invalid credentials')
  }
  const mem = await db.select().from(memberships).where(eq(memberships.userId, user.id)).get()
  if (!mem) throw new HTTPError(403, 'user has no workspace')
  const ws = await db.select().from(workspaces).where(eq(workspaces.id, mem.workspaceId)).get()
  if (!ws) throw new HTTPError(500, 'membership references missing workspace')

  const access_token = await createAccessToken(
    c.env.JWT_SECRET,
    { sub: user.id, ws: ws.id },
    JWT_TTL_SECONDS,
  )
  const res: TokenResponse = {
    access_token,
    token_type: 'Bearer',
    expires_in_seconds: JWT_TTL_SECONDS,
    user_id: user.id,
    workspace_id: ws.id,
    workspace_slug: ws.slug,
  }
  return c.json(res)
})

authRouter.get('/me', requireAuth, (c) => {
  const p = c.var.principal
  return c.json({
    user: p.user
      ? { id: p.user.id, email: p.user.email, display_name: p.user.displayName }
      : null,
    workspace: { id: p.workspace.id, slug: p.workspace.slug, name: p.workspace.name },
    role: p.role,
    auth_kind: p.authKind,
  })
})
