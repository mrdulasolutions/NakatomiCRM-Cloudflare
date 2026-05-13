import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { memberships, users, workspaces } from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth, requireRole } from '../middleware/auth'

export const workspacesRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
workspacesRouter.use('*', requireAuth)

workspacesRouter.get('/current', (c) => {
  const ws = c.var.principal.workspace
  return c.json({
    id: ws.id,
    slug: ws.slug,
    name: ws.name,
    data: ws.data,
    created_at: ws.createdAt,
  })
})

const UpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  data: z.record(z.unknown()).optional(),
})

workspacesRouter.patch('/current', requireRole('owner', 'admin'), async (c) => {
  const body = UpdateSchema.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const ws = c.var.principal.workspace
  await db
    .update(workspaces)
    .set({
      name: body.name ?? ws.name,
      data: body.data ?? ws.data,
    })
    .where(eq(workspaces.id, ws.id))
    .run()
  const updated = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).get()
  if (!updated) throw new HTTPError(500, 'workspace vanished after update')
  return c.json({
    id: updated.id,
    slug: updated.slug,
    name: updated.name,
    data: updated.data,
    created_at: updated.createdAt,
  })
})

workspacesRouter.get('/current/members', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const rows = await db
    .select({
      membership_id: memberships.id,
      user_id: users.id,
      email: users.email,
      display_name: users.displayName,
      role: memberships.role,
      joined_at: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(users, eq(memberships.userId, users.id))
    .where(eq(memberships.workspaceId, wsId))
    .all()
  return c.json({ items: rows })
})
