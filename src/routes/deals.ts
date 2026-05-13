import { and, asc, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import {
  type Deal,
  type DealLineItem,
  type DealStatus,
  type Product,
  type Stage,
  dealLineItems,
  deals,
  pipelines,
  products,
  stages,
} from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const DealCreate = z.object({
  external_id: z.string().max(255).optional(),
  name: z.string().min(1).max(255),
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  pipeline_slug: z.string().optional(),
  stage_slug: z.string().optional(),
  amount: z.string().optional(),
  currency: z.string().length(3).optional(),
  expected_close_date: z.string().datetime().optional(),
  primary_contact_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  owner_user_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  data: z.record(z.unknown()).optional(),
})

const DealUpdate = DealCreate.partial().omit({ pipeline_slug: true, stage_slug: true })

const DealListQuery = PaginationQuery.extend({
  q: z.string().optional(),
  pipeline_id: z.string().uuid().optional(),
  stage_id: z.string().uuid().optional(),
  status: z.enum(['open', 'won', 'lost']).optional(),
  company_id: z.string().uuid().optional(),
  include_deleted: z.coerce.boolean().default(false),
})

const MoveSchema = z.object({
  stage_id: z.string().uuid().optional(),
  stage_slug: z.string().optional(),
})

function serializeDeal(d: Deal) {
  return {
    id: d.id,
    external_id: d.externalId,
    name: d.name,
    pipeline_id: d.pipelineId,
    stage_id: d.stageId,
    status: d.status,
    amount: d.amount,
    currency: d.currency,
    expected_close_date: d.expectedCloseDate,
    closed_at: d.closedAt,
    primary_contact_id: d.primaryContactId,
    company_id: d.companyId,
    owner_user_id: d.ownerUserId,
    tags: d.tags,
    data: d.data,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
    deleted_at: d.deletedAt,
  }
}

function serializeLineItem(l: DealLineItem) {
  return {
    id: l.id,
    deal_id: l.dealId,
    product_id: l.productId,
    name: l.name,
    sku: l.sku,
    quantity: l.quantity,
    unit_price: l.unitPrice,
    currency: l.currency,
    position: l.position,
    data: l.data,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  }
}

async function resolveStage(
  db: ReturnType<typeof makeDb>,
  workspaceId: string,
  body: {
    pipeline_id?: string
    pipeline_slug?: string
    stage_id?: string
    stage_slug?: string
  },
): Promise<{ pipelineId: string; stage: Stage }> {
  let pipelineId = body.pipeline_id ?? null
  if (!pipelineId && body.pipeline_slug) {
    const p = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.slug, body.pipeline_slug)))
      .get()
    if (!p) throw new HTTPError(400, `pipeline "${body.pipeline_slug}" not found`)
    pipelineId = p.id
  }
  if (!pipelineId) {
    // default pipeline
    const def = await db
      .select()
      .from(pipelines)
      .where(and(eq(pipelines.workspaceId, workspaceId), eq(pipelines.isDefault, true)))
      .get()
    if (!def) throw new HTTPError(400, 'no pipeline specified and no default pipeline set')
    pipelineId = def.id
  }

  let stage: Stage | undefined
  if (body.stage_id) {
    stage = await db
      .select()
      .from(stages)
      .where(and(eq(stages.pipelineId, pipelineId), eq(stages.id, body.stage_id)))
      .get()
  } else if (body.stage_slug) {
    stage = await db
      .select()
      .from(stages)
      .where(and(eq(stages.pipelineId, pipelineId), eq(stages.slug, body.stage_slug)))
      .get()
  } else {
    stage = await db
      .select()
      .from(stages)
      .where(eq(stages.pipelineId, pipelineId))
      .orderBy(asc(stages.position))
      .get()
  }
  if (!stage) throw new HTTPError(400, 'stage not found in pipeline')

  return { pipelineId, stage }
}

export const dealsRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
dealsRouter.use('*', requireAuth)

dealsRouter.get('/', async (c) => {
  const q = DealListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const whereClauses = [eq(deals.workspaceId, wsId)]
  if (!q.include_deleted) whereClauses.push(isNull(deals.deletedAt))
  if (q.pipeline_id) whereClauses.push(eq(deals.pipelineId, q.pipeline_id))
  if (q.stage_id) whereClauses.push(eq(deals.stageId, q.stage_id))
  if (q.status) whereClauses.push(eq(deals.status, q.status))
  if (q.company_id) whereClauses.push(eq(deals.companyId, q.company_id))

  if (q.q) {
    const fts = await c.env.DB.prepare(
      'SELECT deal_id FROM deals_fts WHERE workspace_id = ? AND deals_fts MATCH ? LIMIT 500',
    )
      .bind(wsId, q.q)
      .all<{ deal_id: string }>()
    const ids = fts.results.map((r: { deal_id: string }) => r.deal_id)
    if (ids.length === 0) return c.json({ items: [], next_cursor: null })
    whereClauses.push(inArray(deals.id, ids))
  }

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      whereClauses.push(
        or(
          lt(deals.createdAt, new Date(pos.createdAt)),
          and(eq(deals.createdAt, new Date(pos.createdAt)), lt(deals.id, pos.id)),
        )!,
      )
    }
  }

  const rows = await db
    .select()
    .from(deals)
    .where(and(...whereClauses))
    .orderBy(desc(deals.createdAt), desc(deals.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serializeDeal))
})

dealsRouter.post('/', async (c) => {
  const body = DealCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  if (body.external_id) {
    const existing = await db
      .select()
      .from(deals)
      .where(and(eq(deals.workspaceId, wsId), eq(deals.externalId, body.external_id)))
      .get()
    if (existing) throw new HTTPError(409, 'external_id already used in this workspace')
  }

  const { pipelineId, stage } = await resolveStage(db, wsId, body)

  const created = await db
    .insert(deals)
    .values({
      workspaceId: wsId,
      externalId: body.external_id ?? null,
      name: body.name,
      pipelineId,
      stageId: stage.id,
      status: stage.isWon ? 'won' : stage.isLost ? 'lost' : 'open',
      amount: body.amount ?? null,
      currency: body.currency ?? 'USD',
      expectedCloseDate: body.expected_close_date ? new Date(body.expected_close_date) : null,
      closedAt: stage.isWon || stage.isLost ? new Date() : null,
      primaryContactId: body.primary_contact_id ?? null,
      companyId: body.company_id ?? null,
      ownerUserId: body.owner_user_id ?? null,
      tags: body.tags ?? [],
      data: body.data ?? {},
    })
    .returning()
    .get()

  await recordEvent(db, c.var.principal, {
    eventType: 'deal.created',
    entityType: 'deal',
    entityId: created.id,
    payload: { stage_slug: stage.slug, amount: body.amount ?? null },
  })

  return c.json(serializeDeal(created), 201)
})

dealsRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, wsId), eq(deals.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'deal not found')
  return c.json(serializeDeal(row))
})

dealsRouter.patch('/:id', async (c) => {
  const body = DealUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, wsId), eq(deals.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'deal not found')

  const updated = await db
    .update(deals)
    .set({
      externalId: body.external_id ?? existing.externalId,
      name: body.name ?? existing.name,
      amount: body.amount ?? existing.amount,
      currency: body.currency ?? existing.currency,
      expectedCloseDate: body.expected_close_date
        ? new Date(body.expected_close_date)
        : existing.expectedCloseDate,
      primaryContactId: body.primary_contact_id ?? existing.primaryContactId,
      companyId: body.company_id ?? existing.companyId,
      ownerUserId: body.owner_user_id ?? existing.ownerUserId,
      tags: body.tags ?? existing.tags,
      data: body.data ?? existing.data,
    })
    .where(eq(deals.id, id))
    .returning()
    .get()

  await recordEvent(db, c.var.principal, {
    eventType: 'deal.updated',
    entityType: 'deal',
    entityId: id,
    payload: { changed: Object.keys(body) },
  })

  return c.json(serializeDeal(updated!))
})

dealsRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, wsId), eq(deals.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'deal not found')

  await db.update(deals).set({ deletedAt: new Date() }).where(eq(deals.id, id)).run()
  await recordEvent(db, c.var.principal, {
    eventType: 'deal.deleted',
    entityType: 'deal',
    entityId: id,
  })

  return c.body(null, 204)
})

// Move stage. Mirrors legacy POST /deals/:id/move. Recomputes status
// from the destination stage's is_won/is_lost flags and stamps closed_at
// when the move terminates the deal.
dealsRouter.post('/:id/move', async (c) => {
  const body = MoveSchema.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, wsId), eq(deals.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'deal not found')

  const { stage } = await resolveStage(db, wsId, {
    pipeline_id: existing.pipelineId,
    stage_id: body.stage_id,
    stage_slug: body.stage_slug,
  })

  const newStatus: DealStatus = stage.isWon ? 'won' : stage.isLost ? 'lost' : 'open'
  const updated = await db
    .update(deals)
    .set({
      stageId: stage.id,
      status: newStatus,
      closedAt:
        newStatus === 'open' ? null : (existing.closedAt ?? new Date()),
    })
    .where(eq(deals.id, id))
    .returning()
    .get()

  await recordEvent(db, c.var.principal, {
    eventType: 'deal.moved',
    entityType: 'deal',
    entityId: id,
    payload: {
      from_stage_id: existing.stageId,
      to_stage_id: stage.id,
      to_stage_slug: stage.slug,
      status: newStatus,
    },
  })

  return c.json(serializeDeal(updated!))
})

// --- Line items nested under /:dealId/line-items ---

const LineItemCreate = z.object({
  product_id: z.string().uuid().optional(),
  name: z.string().min(1).max(255).optional(),
  sku: z.string().max(64).optional(),
  quantity: z.string().optional(),
  unit_price: z.string().optional(),
  currency: z.string().length(3).optional(),
  position: z.number().int().min(0).optional(),
  data: z.record(z.unknown()).optional(),
})

dealsRouter.get('/:dealId/line-items', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const dealId = c.req.param('dealId')

  const deal = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, wsId), eq(deals.id, dealId)))
    .get()
  if (!deal) throw new HTTPError(404, 'deal not found')

  const rows = await db
    .select()
    .from(dealLineItems)
    .where(eq(dealLineItems.dealId, dealId))
    .orderBy(asc(dealLineItems.position), asc(dealLineItems.createdAt))
    .all()
  return c.json({ items: rows.map(serializeLineItem) })
})

dealsRouter.post('/:dealId/line-items', async (c) => {
  const body = LineItemCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const dealId = c.req.param('dealId')

  const deal = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, wsId), eq(deals.id, dealId)))
    .get()
  if (!deal) throw new HTTPError(404, 'deal not found')

  let product: Product | undefined
  if (body.product_id) {
    product = await db
      .select()
      .from(products)
      .where(and(eq(products.workspaceId, wsId), eq(products.id, body.product_id)))
      .get()
    if (!product) throw new HTTPError(400, 'product not found')
  }

  // Snapshot name + unit_price from product if not explicitly given.
  const name = body.name ?? product?.name
  if (!name) throw new HTTPError(400, 'name required when no product_id is given')
  const unitPrice = body.unit_price ?? product?.unitPrice ?? '0'
  const sku = body.sku ?? product?.sku ?? null

  const created = await db
    .insert(dealLineItems)
    .values({
      dealId,
      productId: body.product_id ?? null,
      name,
      sku,
      quantity: body.quantity ?? '1',
      unitPrice,
      currency: body.currency ?? product?.currency ?? deal.currency,
      position: body.position ?? 0,
      data: body.data ?? {},
    })
    .returning()
    .get()

  await recordEvent(db, c.var.principal, {
    eventType: 'deal.line_item.added',
    entityType: 'deal',
    entityId: dealId,
    payload: { line_item_id: created.id, name, unit_price: unitPrice },
  })

  return c.json(serializeLineItem(created), 201)
})

dealsRouter.delete('/:dealId/line-items/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const dealId = c.req.param('dealId')
  const id = c.req.param('id')

  const deal = await db
    .select()
    .from(deals)
    .where(and(eq(deals.workspaceId, wsId), eq(deals.id, dealId)))
    .get()
  if (!deal) throw new HTTPError(404, 'deal not found')

  const existing = await db
    .select()
    .from(dealLineItems)
    .where(and(eq(dealLineItems.dealId, dealId), eq(dealLineItems.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'line item not found')

  await db.delete(dealLineItems).where(eq(dealLineItems.id, id)).run()

  await recordEvent(db, c.var.principal, {
    eventType: 'deal.line_item.removed',
    entityType: 'deal',
    entityId: dealId,
    payload: { line_item_id: id },
  })

  return c.body(null, 204)
})
