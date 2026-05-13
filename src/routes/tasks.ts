import { and, asc, desc, eq, gte, isNotNull, isNull, lt, lte, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, TASK_STATUSES, type Task, tasks } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)
const StatusEnum = z.enum(TASK_STATUSES)

const TaskCreate = z.object({
  external_id: z.string().max(255).optional(),
  title: z.string().min(1).max(512),
  description: z.string().optional(),
  status: StatusEnum.optional(),
  due_at: z.string().datetime().optional(),
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  assignee_user_id: z.string().uuid().optional(),
  data: z.record(z.unknown()).optional(),
})

const TaskUpdate = TaskCreate.partial()

const TaskListQuery = PaginationQuery.extend({
  status: StatusEnum.optional(),
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  assignee_user_id: z.string().uuid().optional(),
  due_before: z.string().datetime().optional(),
  due_after: z.string().datetime().optional(),
  overdue: z.coerce.boolean().optional(),
})

function serialize(t: Task) {
  return {
    id: t.id,
    external_id: t.externalId,
    title: t.title,
    description: t.description,
    status: t.status,
    due_at: t.dueAt,
    completed_at: t.completedAt,
    entity_type: t.entityType,
    entity_id: t.entityId,
    assignee_user_id: t.assigneeUserId,
    data: t.data,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    deleted_at: t.deletedAt,
  }
}

export const tasksRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
tasksRouter.use('*', requireAuth)

tasksRouter.get('/', async (c) => {
  const q = TaskListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const where = [eq(tasks.workspaceId, wsId), isNull(tasks.deletedAt)]
  if (q.status) where.push(eq(tasks.status, q.status))
  if (q.entity_type) where.push(eq(tasks.entityType, q.entity_type))
  if (q.entity_id) where.push(eq(tasks.entityId, q.entity_id))
  if (q.assignee_user_id) where.push(eq(tasks.assigneeUserId, q.assignee_user_id))
  if (q.due_before) where.push(lte(tasks.dueAt, new Date(q.due_before)))
  if (q.due_after) where.push(gte(tasks.dueAt, new Date(q.due_after)))
  if (q.overdue) {
    where.push(isNotNull(tasks.dueAt))
    where.push(lt(tasks.dueAt, new Date()))
    where.push(or(eq(tasks.status, 'open'), eq(tasks.status, 'in_progress'))!)
  }

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      where.push(
        or(
          lt(tasks.createdAt, new Date(pos.createdAt)),
          and(eq(tasks.createdAt, new Date(pos.createdAt)), lt(tasks.id, pos.id)),
        )!,
      )
    }
  }

  // Default ordering biases due_at when present, fall back to created_at.
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...where))
    .orderBy(asc(tasks.dueAt), desc(tasks.createdAt), desc(tasks.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serialize))
})

tasksRouter.post('/', async (c) => {
  const body = TaskCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  if (body.external_id) {
    const existing = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.workspaceId, wsId), eq(tasks.externalId, body.external_id)))
      .get()
    if (existing) throw new HTTPError(409, 'external_id already used in this workspace')
  }

  const created = await db
    .insert(tasks)
    .values({
      workspaceId: wsId,
      externalId: body.external_id ?? null,
      title: body.title,
      description: body.description ?? null,
      status: body.status ?? 'open',
      dueAt: body.due_at ? new Date(body.due_at) : null,
      entityType: body.entity_type ?? null,
      entityId: body.entity_id ?? null,
      assigneeUserId: body.assignee_user_id ?? null,
      data: body.data ?? {},
    })
    .returning()
    .get()

  if (created.entityType && created.entityId) {
    await recordEvent(c, {
      eventType: 'task.created',
      entityType: created.entityType,
      entityId: created.entityId,
      payload: { task_id: created.id, title: created.title },
    })
  }

  return c.json(serialize(created), 201)
})

tasksRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, wsId), eq(tasks.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'task not found')
  return c.json(serialize(row))
})

tasksRouter.patch('/:id', async (c) => {
  const body = TaskUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, wsId), eq(tasks.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'task not found')

  // Auto-stamp completed_at on status transitions to done|cancelled.
  let completedAt = existing.completedAt
  if (body.status === 'done' || body.status === 'cancelled') {
    completedAt = existing.completedAt ?? new Date()
  } else if (body.status === 'open' || body.status === 'in_progress') {
    completedAt = null
  }

  const updated = await db
    .update(tasks)
    .set({
      externalId: body.external_id ?? existing.externalId,
      title: body.title ?? existing.title,
      description: body.description ?? existing.description,
      status: body.status ?? existing.status,
      dueAt: body.due_at ? new Date(body.due_at) : existing.dueAt,
      completedAt,
      entityType: body.entity_type ?? existing.entityType,
      entityId: body.entity_id ?? existing.entityId,
      assigneeUserId: body.assignee_user_id ?? existing.assigneeUserId,
      data: body.data ?? existing.data,
    })
    .where(eq(tasks.id, id))
    .returning()
    .get()

  if (body.status && updated?.entityType && updated.entityId) {
    await recordEvent(c, {
      eventType: `task.${body.status}`,
      entityType: updated.entityType,
      entityId: updated.entityId,
      payload: { task_id: id },
    })
  }

  return c.json(serialize(updated!))
})

tasksRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, wsId), eq(tasks.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'task not found')

  await db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, id)).run()
  return c.body(null, 204)
})

// POST /:id/complete — sugar for PATCH { status: 'done' }
tasksRouter.post('/:id/complete', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.workspaceId, wsId), eq(tasks.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'task not found')

  const updated = await db
    .update(tasks)
    .set({ status: 'done', completedAt: new Date() })
    .where(eq(tasks.id, id))
    .returning()
    .get()

  if (updated?.entityType && updated.entityId) {
    await recordEvent(c, {
      eventType: 'task.done',
      entityType: updated.entityType,
      entityId: updated.entityId,
      payload: { task_id: id },
    })
  }
  return c.json(serialize(updated!))
})
