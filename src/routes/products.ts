import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { type Product, products } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const ProductCreate = z.object({
  external_id: z.string().max(255).optional(),
  name: z.string().min(1).max(255),
  sku: z.string().max(64).optional(),
  description: z.string().optional(),
  unit_price: z.string().optional(),
  currency: z
    .string()
    .length(3)
    .optional(),
  is_active: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  data: z.record(z.unknown()).optional(),
})

const ProductUpdate = ProductCreate.partial()

const ProductListQuery = PaginationQuery.extend({
  q: z.string().optional(),
  sku: z.string().optional(),
  is_active: z.coerce.boolean().optional(),
  include_deleted: z.coerce.boolean().default(false),
})

function serialize(p: Product) {
  return {
    id: p.id,
    external_id: p.externalId,
    name: p.name,
    sku: p.sku,
    description: p.description,
    unit_price: p.unitPrice,
    currency: p.currency,
    is_active: p.isActive,
    tags: p.tags,
    data: p.data,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    deleted_at: p.deletedAt,
  }
}

export const productsRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
productsRouter.use('*', requireAuth)

productsRouter.get('/', async (c) => {
  const q = ProductListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const whereClauses = [eq(products.workspaceId, wsId)]
  if (!q.include_deleted) whereClauses.push(isNull(products.deletedAt))
  if (q.sku) whereClauses.push(eq(products.sku, q.sku))
  if (q.is_active != null) whereClauses.push(eq(products.isActive, q.is_active))

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      whereClauses.push(
        or(
          lt(products.createdAt, new Date(pos.createdAt)),
          and(eq(products.createdAt, new Date(pos.createdAt)), lt(products.id, pos.id)),
        )!,
      )
    }
  }

  const rows = await db
    .select()
    .from(products)
    .where(and(...whereClauses))
    .orderBy(desc(products.createdAt), desc(products.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serialize))
})

productsRouter.post('/', async (c) => {
  const body = ProductCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  if (body.sku) {
    const existing = await db
      .select()
      .from(products)
      .where(and(eq(products.workspaceId, wsId), eq(products.sku, body.sku)))
      .get()
    if (existing) throw new HTTPError(409, 'SKU already used in this workspace')
  }
  if (body.external_id) {
    const existing = await db
      .select()
      .from(products)
      .where(and(eq(products.workspaceId, wsId), eq(products.externalId, body.external_id)))
      .get()
    if (existing) throw new HTTPError(409, 'external_id already used in this workspace')
  }

  const created = await db
    .insert(products)
    .values({
      workspaceId: wsId,
      externalId: body.external_id ?? null,
      name: body.name,
      sku: body.sku ?? null,
      description: body.description ?? null,
      unitPrice: body.unit_price ?? null,
      currency: body.currency ?? 'USD',
      isActive: body.is_active ?? true,
      tags: body.tags ?? [],
      data: body.data ?? {},
    })
    .returning()
    .get()

  await recordEvent(db, c.var.principal, {
    eventType: 'product.created',
    entityType: 'product',
    entityId: created.id,
  })

  return c.json(serialize(created), 201)
})

productsRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(products)
    .where(and(eq(products.workspaceId, wsId), eq(products.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'product not found')
  return c.json(serialize(row))
})

productsRouter.patch('/:id', async (c) => {
  const body = ProductUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(products)
    .where(and(eq(products.workspaceId, wsId), eq(products.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'product not found')

  const updated = await db
    .update(products)
    .set({
      externalId: body.external_id ?? existing.externalId,
      name: body.name ?? existing.name,
      sku: body.sku ?? existing.sku,
      description: body.description ?? existing.description,
      unitPrice: body.unit_price ?? existing.unitPrice,
      currency: body.currency ?? existing.currency,
      isActive: body.is_active ?? existing.isActive,
      tags: body.tags ?? existing.tags,
      data: body.data ?? existing.data,
    })
    .where(eq(products.id, id))
    .returning()
    .get()

  await recordEvent(db, c.var.principal, {
    eventType: 'product.updated',
    entityType: 'product',
    entityId: id,
    payload: { changed: Object.keys(body) },
  })

  return c.json(serialize(updated!))
})

productsRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(products)
    .where(and(eq(products.workspaceId, wsId), eq(products.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'product not found')

  await db.update(products).set({ deletedAt: new Date() }).where(eq(products.id, id)).run()
  await recordEvent(db, c.var.principal, {
    eventType: 'product.deleted',
    entityType: 'product',
    entityId: id,
  })

  return c.body(null, 204)
})
