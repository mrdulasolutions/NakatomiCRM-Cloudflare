import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { type Company, companies } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const CompanyCreate = z.object({
  external_id: z.string().max(255).optional(),
  name: z.string().min(1).max(255),
  domain: z.string().max(255).optional(),
  website: z.string().url().max(512).optional(),
  industry: z.string().max(255).optional(),
  employee_count: z.number().int().min(0).optional(),
  annual_revenue: z.string().optional(), // numeric-as-string
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  data: z.record(z.unknown()).optional(),
})

const CompanyUpdate = CompanyCreate.partial()

const CompanyListQuery = PaginationQuery.extend({
  q: z.string().optional(),
  domain: z.string().optional(),
  include_deleted: z.coerce.boolean().default(false),
})

function serialize(co: Company) {
  return {
    id: co.id,
    external_id: co.externalId,
    name: co.name,
    domain: co.domain,
    website: co.website,
    industry: co.industry,
    employee_count: co.employeeCount,
    annual_revenue: co.annualRevenue,
    description: co.description,
    tags: co.tags,
    data: co.data,
    created_at: co.createdAt,
    updated_at: co.updatedAt,
    deleted_at: co.deletedAt,
  }
}

export const companiesRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
companiesRouter.use('*', requireAuth)

companiesRouter.get('/', async (c) => {
  const q = CompanyListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const whereClauses = [eq(companies.workspaceId, wsId)]
  if (!q.include_deleted) whereClauses.push(isNull(companies.deletedAt))
  if (q.domain) whereClauses.push(eq(companies.domain, q.domain))

  if (q.q) {
    const fts = await c.env.DB.prepare(
      'SELECT company_id FROM companies_fts WHERE workspace_id = ? AND companies_fts MATCH ? LIMIT 500',
    )
      .bind(wsId, q.q)
      .all<{ company_id: string }>()
    const ids = fts.results.map((r: { company_id: string }) => r.company_id)
    if (ids.length === 0) return c.json({ items: [], next_cursor: null })
    whereClauses.push(inArray(companies.id, ids))
  }

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      whereClauses.push(
        or(
          lt(companies.createdAt, new Date(pos.createdAt)),
          and(eq(companies.createdAt, new Date(pos.createdAt)), lt(companies.id, pos.id)),
        )!,
      )
    }
  }

  const rows = await db
    .select()
    .from(companies)
    .where(and(...whereClauses))
    .orderBy(desc(companies.createdAt), desc(companies.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serialize))
})

companiesRouter.post('/', async (c) => {
  const body = CompanyCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  if (body.external_id) {
    const existing = await db
      .select()
      .from(companies)
      .where(and(eq(companies.workspaceId, wsId), eq(companies.externalId, body.external_id)))
      .get()
    if (existing) throw new HTTPError(409, 'external_id already used in this workspace')
  }

  const created = await db
    .insert(companies)
    .values({
      workspaceId: wsId,
      externalId: body.external_id ?? null,
      name: body.name,
      domain: body.domain ?? null,
      website: body.website ?? null,
      industry: body.industry ?? null,
      employeeCount: body.employee_count ?? null,
      annualRevenue: body.annual_revenue ?? null,
      description: body.description ?? null,
      tags: body.tags ?? [],
      data: body.data ?? {},
    })
    .returning()
    .get()

  await recordEvent(c, {
    eventType: 'company.created',
    entityType: 'company',
    entityId: created.id,
  })

  return c.json(serialize(created), 201)
})

companiesRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, wsId), eq(companies.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'company not found')
  return c.json(serialize(row))
})

companiesRouter.patch('/:id', async (c) => {
  const body = CompanyUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, wsId), eq(companies.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'company not found')

  const updated = await db
    .update(companies)
    .set({
      externalId: body.external_id ?? existing.externalId,
      name: body.name ?? existing.name,
      domain: body.domain ?? existing.domain,
      website: body.website ?? existing.website,
      industry: body.industry ?? existing.industry,
      employeeCount: body.employee_count ?? existing.employeeCount,
      annualRevenue: body.annual_revenue ?? existing.annualRevenue,
      description: body.description ?? existing.description,
      tags: body.tags ?? existing.tags,
      data: body.data ?? existing.data,
    })
    .where(eq(companies.id, id))
    .returning()
    .get()

  await recordEvent(c, {
    eventType: 'company.updated',
    entityType: 'company',
    entityId: id,
    payload: { changed: Object.keys(body) },
  })

  return c.json(serialize(updated!))
})

companiesRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, wsId), eq(companies.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'company not found')

  await db.update(companies).set({ deletedAt: new Date() }).where(eq(companies.id, id)).run()
  await recordEvent(c, {
    eventType: 'company.deleted',
    entityType: 'company',
    entityId: id,
  })

  return c.body(null, 204)
})

companiesRouter.post('/:id/restore', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(companies)
    .where(and(eq(companies.workspaceId, wsId), eq(companies.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'company not found')
  if (!existing.deletedAt) return c.json(serialize(existing))

  const restored = await db
    .update(companies)
    .set({ deletedAt: null })
    .where(eq(companies.id, id))
    .returning()
    .get()
  await recordEvent(c, {
    eventType: 'company.restored',
    entityType: 'company',
    entityId: id,
  })
  return c.json(serialize(restored!))
})
