import { and, eq, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, type Relationship, relationships } from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)

const RelCreate = z.object({
  source_type: EntityEnum,
  source_id: z.string().uuid(),
  target_type: EntityEnum,
  target_id: z.string().uuid(),
  relation_type: z.string().min(1).max(64),
  strength: z.number().min(0).max(100).optional(),
  data: z.record(z.unknown()).optional(),
})

const RelListQuery = z.object({
  source_type: EntityEnum.optional(),
  source_id: z.string().uuid().optional(),
  target_type: EntityEnum.optional(),
  target_id: z.string().uuid().optional(),
  relation_type: z.string().optional(),
})

function serialize(r: Relationship) {
  return {
    id: r.id,
    source_type: r.sourceType,
    source_id: r.sourceId,
    target_type: r.targetType,
    target_id: r.targetId,
    relation_type: r.relationType,
    strength: r.strength,
    data: r.data,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }
}

export const relationshipsRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
relationshipsRouter.use('*', requireAuth)

relationshipsRouter.get('/', async (c) => {
  const q = RelListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const where = [eq(relationships.workspaceId, wsId)]
  if (q.source_type) where.push(eq(relationships.sourceType, q.source_type))
  if (q.source_id) where.push(eq(relationships.sourceId, q.source_id))
  if (q.target_type) where.push(eq(relationships.targetType, q.target_type))
  if (q.target_id) where.push(eq(relationships.targetId, q.target_id))
  if (q.relation_type) where.push(eq(relationships.relationType, q.relation_type))

  const rows = await db
    .select()
    .from(relationships)
    .where(and(...where))
    .all()
  return c.json({ items: rows.map(serialize) })
})

// GET /v1/relationships/neighbors?entity_type=X&entity_id=Y — both directions
relationshipsRouter.get('/neighbors', async (c) => {
  const entityType = EntityEnum.parse(c.req.query('entity_type'))
  const entityId = z.string().uuid().parse(c.req.query('entity_id'))

  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const rows = await db
    .select()
    .from(relationships)
    .where(
      and(
        eq(relationships.workspaceId, wsId),
        or(
          and(eq(relationships.sourceType, entityType), eq(relationships.sourceId, entityId)),
          and(eq(relationships.targetType, entityType), eq(relationships.targetId, entityId)),
        )!,
      ),
    )
    .all()

  // Annotate each edge with which direction the requesting entity sits on.
  const items = rows.map((r) => ({
    ...serialize(r),
    direction:
      r.sourceType === entityType && r.sourceId === entityId ? ('outgoing' as const) : ('incoming' as const),
  }))
  return c.json({ items })
})

relationshipsRouter.post('/', async (c) => {
  const body = RelCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  // The uq_relationship_edge constraint forbids exact duplicates.
  try {
    const created = await db
      .insert(relationships)
      .values({
        workspaceId: wsId,
        sourceType: body.source_type,
        sourceId: body.source_id,
        targetType: body.target_type,
        targetId: body.target_id,
        relationType: body.relation_type,
        strength: body.strength != null ? String(body.strength) : '1',
        data: body.data ?? {},
      })
      .returning()
      .get()
    return c.json(serialize(created), 201)
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new HTTPError(409, 'relationship edge already exists')
    }
    throw err
  }
})

relationshipsRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')
  const existing = await db
    .select()
    .from(relationships)
    .where(and(eq(relationships.workspaceId, wsId), eq(relationships.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'relationship not found')
  await db.delete(relationships).where(eq(relationships.id, id)).run()
  return c.body(null, 204)
})
