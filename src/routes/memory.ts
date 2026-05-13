import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, type MemoryLink, memoryLinks } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { loadConnectors } from '../memory/registry'
import { type AppVars, requireAuth } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)

const LinkCreate = z.object({
  connector: z.string().min(1).max(64),
  external_id: z.string().min(1).max(255),
  crm_entity_type: EntityEnum,
  crm_entity_id: z.string().uuid(),
  note: z.string().optional(),
  data: z.record(z.unknown()).optional(),
})

const RecallRequest = z.object({
  query: z.string().min(1),
  connectors: z.array(z.string()).optional(),
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(50).default(10),
})

function serializeLink(l: MemoryLink) {
  return {
    id: l.id,
    connector: l.connector,
    external_id: l.externalId,
    crm_entity_type: l.crmEntityType,
    crm_entity_id: l.crmEntityId,
    note: l.note,
    data: l.data,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  }
}

export const memoryRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
memoryRouter.use('*', requireAuth)

memoryRouter.get('/connectors', (c) => {
  const enabled = [...loadConnectors(c.env).keys()]
  return c.json({ items: enabled })
})

memoryRouter.get('/links', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const connector = c.req.query('connector')
  const entityType = c.req.query('entity_type')
  const entityId = c.req.query('entity_id')

  const where = [eq(memoryLinks.workspaceId, wsId)]
  if (connector) where.push(eq(memoryLinks.connector, connector))
  if (entityType && (ENTITY_TYPES as readonly string[]).includes(entityType)) {
    where.push(eq(memoryLinks.crmEntityType, entityType as (typeof ENTITY_TYPES)[number]))
  }
  if (entityId) where.push(eq(memoryLinks.crmEntityId, entityId))

  const rows = await db
    .select()
    .from(memoryLinks)
    .where(and(...where))
    .all()
  return c.json({ items: rows.map(serializeLink) })
})

memoryRouter.get('/trace/:entityType/:entityId', async (c) => {
  const entityType = EntityEnum.parse(c.req.param('entityType'))
  const entityId = z.string().uuid().parse(c.req.param('entityId'))

  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const rows = await db
    .select()
    .from(memoryLinks)
    .where(
      and(
        eq(memoryLinks.workspaceId, wsId),
        eq(memoryLinks.crmEntityType, entityType),
        eq(memoryLinks.crmEntityId, entityId),
      ),
    )
    .all()
  return c.json({ items: rows.map(serializeLink) })
})

memoryRouter.post('/link', async (c) => {
  const body = LinkCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  try {
    const created = await db
      .insert(memoryLinks)
      .values({
        workspaceId: wsId,
        connector: body.connector,
        externalId: body.external_id,
        crmEntityType: body.crm_entity_type,
        crmEntityId: body.crm_entity_id,
        note: body.note ?? null,
        data: body.data ?? {},
      })
      .returning()
      .get()

    await recordEvent(c, {
      eventType: 'memory.linked',
      entityType: body.crm_entity_type,
      entityId: body.crm_entity_id,
      payload: { connector: body.connector, external_id: body.external_id, link_id: created.id },
    })

    return c.json(serializeLink(created), 201)
  } catch (err) {
    if (err instanceof Error && /UNIQUE/i.test(err.message)) {
      throw new HTTPError(409, 'memory link already exists')
    }
    throw err
  }
})

memoryRouter.delete('/link/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')
  const existing = await db
    .select()
    .from(memoryLinks)
    .where(and(eq(memoryLinks.workspaceId, wsId), eq(memoryLinks.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'link not found')

  await db.delete(memoryLinks).where(eq(memoryLinks.id, id)).run()
  await recordEvent(c, {
    eventType: 'memory.unlinked',
    entityType: existing.crmEntityType,
    entityId: existing.crmEntityId,
    payload: { connector: existing.connector, external_id: existing.externalId },
  })
  return c.body(null, 204)
})

memoryRouter.post('/recall', async (c) => {
  const body = RecallRequest.parse(await c.req.json())
  const connectors = loadConnectors(c.env)
  const targets = body.connectors ?? [...connectors.keys()]

  const results: Array<{
    connector: string
    external_id: string
    text: string
    score: number
    metadata?: Record<string, unknown>
    crm_links: string[]
  }> = []

  for (const name of targets) {
    const conn = connectors.get(name)
    if (!conn) continue
    try {
      const hits = await conn.recall({
        workspaceId: c.var.principal.workspace.id,
        query: body.query,
        crmEntityType: body.entity_type ?? null,
        crmEntityId: body.entity_id ?? null,
        limit: body.limit,
      })
      const db = makeDb(c.env.DB)
      for (const m of hits) {
        const links = await db
          .select()
          .from(memoryLinks)
          .where(
            and(
              eq(memoryLinks.workspaceId, c.var.principal.workspace.id),
              eq(memoryLinks.connector, name),
              eq(memoryLinks.externalId, m.external_id),
            ),
          )
          .all()
        results.push({
          ...m,
          crm_links: links.map((l) => `${l.crmEntityType}:${l.crmEntityId}`),
        })
      }
    } catch (err) {
      console.warn(`recall failed for connector "${name}":`, err)
    }
  }

  results.sort((a, b) => b.score - a.score)
  return c.json({ items: results.slice(0, body.limit) })
})
