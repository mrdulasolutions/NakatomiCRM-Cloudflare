import { and, desc, eq, gte, isNull, lt, lte, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, type Activity, activities } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)

const ActivityCreate = z.object({
  external_id: z.string().max(255).optional(),
  kind: z.string().min(1).max(64), // call, meeting, email_log, etc.
  subject: z.string().max(512).optional(),
  body: z.string().optional(),
  occurred_at: z.string().datetime().optional(),
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  data: z.record(z.unknown()).optional(),
})

const ActivityUpdate = ActivityCreate.partial()

const ActivityListQuery = PaginationQuery.extend({
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  kind: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
})

function serialize(a: Activity) {
  return {
    id: a.id,
    external_id: a.externalId,
    kind: a.kind,
    subject: a.subject,
    body: a.body,
    occurred_at: a.occurredAt,
    entity_type: a.entityType,
    entity_id: a.entityId,
    actor_user_id: a.actorUserId,
    data: a.data,
    created_at: a.createdAt,
    updated_at: a.updatedAt,
  }
}

export const activitiesRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
activitiesRouter.use('*', requireAuth)

activitiesRouter.get('/', async (c) => {
  const q = ActivityListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const where = [eq(activities.workspaceId, wsId), isNull(activities.deletedAt)]
  if (q.entity_type) where.push(eq(activities.entityType, q.entity_type))
  if (q.entity_id) where.push(eq(activities.entityId, q.entity_id))
  if (q.kind) where.push(eq(activities.kind, q.kind))
  if (q.since) where.push(gte(activities.occurredAt, new Date(q.since)))
  if (q.until) where.push(lte(activities.occurredAt, new Date(q.until)))

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      where.push(
        or(
          lt(activities.createdAt, new Date(pos.createdAt)),
          and(eq(activities.createdAt, new Date(pos.createdAt)), lt(activities.id, pos.id)),
        )!,
      )
    }
  }

  const rows = await db
    .select()
    .from(activities)
    .where(and(...where))
    .orderBy(desc(activities.occurredAt), desc(activities.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serialize))
})

activitiesRouter.post('/', async (c) => {
  const body = ActivityCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  if (body.external_id) {
    const existing = await db
      .select()
      .from(activities)
      .where(and(eq(activities.workspaceId, wsId), eq(activities.externalId, body.external_id)))
      .get()
    if (existing) throw new HTTPError(409, 'external_id already used in this workspace')
  }

  const created = await db
    .insert(activities)
    .values({
      workspaceId: wsId,
      externalId: body.external_id ?? null,
      kind: body.kind,
      subject: body.subject ?? null,
      body: body.body ?? null,
      occurredAt: body.occurred_at ? new Date(body.occurred_at) : new Date(),
      entityType: body.entity_type ?? null,
      entityId: body.entity_id ?? null,
      actorUserId: c.var.principal.user?.id ?? null,
      data: body.data ?? {},
    })
    .returning()
    .get()

  // Timeline event attached to the *referenced* entity, not to the activity itself
  if (created.entityType && created.entityId) {
    await recordEvent(c, {
      eventType: `activity.${body.kind}`,
      entityType: created.entityType,
      entityId: created.entityId,
      payload: { activity_id: created.id, subject: body.subject ?? null },
    })
  }

  return c.json(serialize(created), 201)
})

activitiesRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(activities)
    .where(and(eq(activities.workspaceId, wsId), eq(activities.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'activity not found')
  return c.json(serialize(row))
})

activitiesRouter.patch('/:id', async (c) => {
  const body = ActivityUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(activities)
    .where(and(eq(activities.workspaceId, wsId), eq(activities.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'activity not found')

  const updated = await db
    .update(activities)
    .set({
      externalId: body.external_id ?? existing.externalId,
      kind: body.kind ?? existing.kind,
      subject: body.subject ?? existing.subject,
      body: body.body ?? existing.body,
      occurredAt: body.occurred_at ? new Date(body.occurred_at) : existing.occurredAt,
      entityType: body.entity_type ?? existing.entityType,
      entityId: body.entity_id ?? existing.entityId,
      data: body.data ?? existing.data,
    })
    .where(eq(activities.id, id))
    .returning()
    .get()
  return c.json(serialize(updated!))
})

activitiesRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(activities)
    .where(and(eq(activities.workspaceId, wsId), eq(activities.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'activity not found')

  await db.update(activities).set({ deletedAt: new Date() }).where(eq(activities.id, id)).run()
  return c.body(null, 204)
})
