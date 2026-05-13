import { and, desc, eq, gte, lt, lte, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, type TimelineEvent, timelineEvents } from '../db/schema'
import type { Env } from '../env'
import { type AppVars, requireAuth } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)

const TimelineQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  /** Cursor is the smallest event id seen so far; we page descending. */
  before_id: z.coerce.number().int().optional(),
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  event_type: z.string().optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
})

function serialize(e: TimelineEvent) {
  return {
    id: e.id,
    entity_type: e.entityType,
    entity_id: e.entityId,
    event_type: e.eventType,
    occurred_at: e.occurredAt,
    actor_user_id: e.actorUserId,
    actor_api_key_id: e.actorApiKeyId,
    payload: e.payload,
  }
}

export const timelineRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
timelineRouter.use('*', requireAuth)

timelineRouter.get('/', async (c) => {
  const q = TimelineQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const where = [eq(timelineEvents.workspaceId, wsId)]
  if (q.entity_type) where.push(eq(timelineEvents.entityType, q.entity_type))
  if (q.entity_id) where.push(eq(timelineEvents.entityId, q.entity_id))
  if (q.event_type) where.push(eq(timelineEvents.eventType, q.event_type))
  if (q.since) where.push(gte(timelineEvents.occurredAt, new Date(q.since)))
  if (q.until) where.push(lte(timelineEvents.occurredAt, new Date(q.until)))
  if (q.before_id != null) where.push(lt(timelineEvents.id, q.before_id))

  const rows = await db
    .select()
    .from(timelineEvents)
    .where(and(...where))
    .orderBy(desc(timelineEvents.id))
    .limit(q.limit + 1)
    .all()

  const hasMore = rows.length > q.limit
  const items = hasMore ? rows.slice(0, q.limit) : rows
  const last = items[items.length - 1]
  return c.json({
    items: items.map(serialize),
    next_before_id: hasMore && last ? last.id : null,
  })
})
// suppress unused warnings if linter ever rolls
void or
