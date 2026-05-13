import { and, desc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { type Webhook, webhookDeliveries, webhooks } from '../db/schema'
import type { Env } from '../env'
import { hexEncode } from '../lib/encoding'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth, requireRole } from '../middleware/auth'

const WebhookCreate = z.object({
  name: z.string().min(1).max(255),
  url: z.string().url().max(2048),
  events: z.array(z.string().min(1)).min(1),
  is_active: z.boolean().optional(),
})

const WebhookUpdate = z.object({
  name: z.string().min(1).max(255).optional(),
  url: z.string().url().max(2048).optional(),
  events: z.array(z.string().min(1)).min(1).optional(),
  is_active: z.boolean().optional(),
})

function serialize(w: Webhook, { revealSecret = false } = {}) {
  return {
    id: w.id,
    name: w.name,
    url: w.url,
    events: w.events,
    is_active: w.isActive,
    failure_count: w.failureCount,
    last_delivery_at: w.lastDeliveryAt,
    last_error: w.lastError,
    created_at: w.createdAt,
    updated_at: w.updatedAt,
    secret: revealSecret ? w.secret : null,
  }
}

function newSecret(): string {
  return `whsk_${hexEncode(crypto.getRandomValues(new Uint8Array(24)))}`
}

export const webhooksRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
webhooksRouter.use('*', requireAuth)

webhooksRouter.get('/', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const rows = await db
    .select()
    .from(webhooks)
    .where(eq(webhooks.workspaceId, wsId))
    .orderBy(desc(webhooks.createdAt))
    .all()
  return c.json({ items: rows.map((w) => serialize(w)) })
})

webhooksRouter.post('/', requireRole('owner', 'admin'), async (c) => {
  const body = WebhookCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const secret = newSecret()
  const created = await db
    .insert(webhooks)
    .values({
      workspaceId: wsId,
      name: body.name,
      url: body.url,
      secret,
      events: body.events,
      isActive: body.is_active ?? true,
    })
    .returning()
    .get()

  // Secret is shown only on the create call. Re-create the webhook to
  // get a new one — there's no PATCH /secret endpoint by design.
  return c.json(serialize(created, { revealSecret: true }), 201)
})

webhooksRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, wsId), eq(webhooks.id, c.req.param('id'))))
    .get()
  if (!row) throw new HTTPError(404, 'webhook not found')
  return c.json(serialize(row))
})

webhooksRouter.patch('/:id', requireRole('owner', 'admin'), async (c) => {
  const body = WebhookUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, wsId), eq(webhooks.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'webhook not found')

  const updated = await db
    .update(webhooks)
    .set({
      name: body.name ?? existing.name,
      url: body.url ?? existing.url,
      events: body.events ?? existing.events,
      isActive: body.is_active ?? existing.isActive,
    })
    .where(eq(webhooks.id, id))
    .returning()
    .get()
  return c.json(serialize(updated!))
})

webhooksRouter.delete('/:id', requireRole('owner', 'admin'), async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')
  const existing = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, wsId), eq(webhooks.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'webhook not found')
  await db.delete(webhooks).where(eq(webhooks.id, id)).run()
  return c.body(null, 204)
})

webhooksRouter.get('/:id/deliveries', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const hook = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, wsId), eq(webhooks.id, id)))
    .get()
  if (!hook) throw new HTTPError(404, 'webhook not found')

  const limit = Math.min(
    Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1),
    200,
  )
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.webhookId, id))
    .orderBy(desc(webhookDeliveries.id))
    .limit(limit)
    .all()
  return c.json({ items: rows })
})
