import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { type Contact, contacts } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const ContactCreate = z.object({
  external_id: z.string().max(255).optional(),
  first_name: z.string().max(255).optional(),
  last_name: z.string().max(255).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(64).optional(),
  title: z.string().max(255).optional(),
  company_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  data: z.record(z.unknown()).optional(),
})

const ContactUpdate = ContactCreate.partial()

const ContactListQuery = PaginationQuery.extend({
  q: z.string().optional(),
  email: z.string().optional(),
  company_id: z.string().uuid().optional(),
  include_deleted: z.coerce.boolean().default(false),
})

function serialize(c: Contact) {
  return {
    id: c.id,
    external_id: c.externalId,
    first_name: c.firstName,
    last_name: c.lastName,
    email: c.email,
    phone: c.phone,
    title: c.title,
    company_id: c.companyId,
    tags: c.tags,
    data: c.data,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    deleted_at: c.deletedAt,
  }
}

export const contactsRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
contactsRouter.use('*', requireAuth)

// --- List ---
contactsRouter.get('/', async (c) => {
  const q = ContactListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const whereClauses = [eq(contacts.workspaceId, wsId)]
  if (!q.include_deleted) whereClauses.push(isNull(contacts.deletedAt))
  if (q.email) whereClauses.push(eq(contacts.email, q.email))
  if (q.company_id) whereClauses.push(eq(contacts.companyId, q.company_id))

  if (q.q) {
    // FTS for fuzzy search across first_name / last_name / email / title.
    const fts = await c.env.DB.prepare(
      'SELECT contact_id FROM contacts_fts WHERE workspace_id = ? AND contacts_fts MATCH ? LIMIT 500',
    )
      .bind(wsId, q.q)
      .all<{ contact_id: string }>()
    const ids = fts.results.map((r: { contact_id: string }) => r.contact_id)
    if (ids.length === 0) return c.json({ items: [], next_cursor: null })
    whereClauses.push(inArray(contacts.id, ids))
  }

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      whereClauses.push(
        or(
          lt(contacts.createdAt, new Date(pos.createdAt)),
          and(eq(contacts.createdAt, new Date(pos.createdAt)), lt(contacts.id, pos.id)),
        )!,
      )
    }
  }

  const rows = await db
    .select()
    .from(contacts)
    .where(and(...whereClauses))
    .orderBy(desc(contacts.createdAt), desc(contacts.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serialize))
})

// --- Create ---
contactsRouter.post('/', async (c) => {
  const body = ContactCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  if (body.external_id) {
    const existing = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.workspaceId, wsId), eq(contacts.externalId, body.external_id)))
      .get()
    if (existing) throw new HTTPError(409, 'external_id already used in this workspace')
  }

  const created = await db
    .insert(contacts)
    .values({
      workspaceId: wsId,
      externalId: body.external_id ?? null,
      firstName: body.first_name ?? null,
      lastName: body.last_name ?? null,
      email: body.email ?? null,
      phone: body.phone ?? null,
      title: body.title ?? null,
      companyId: body.company_id ?? null,
      tags: body.tags ?? [],
      data: body.data ?? {},
    })
    .returning()
    .get()

  await recordEvent(c, {
    eventType: 'contact.created',
    entityType: 'contact',
    entityId: created.id,
  })

  return c.json(serialize(created), 201)
})

// --- Get ---
contactsRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, wsId), eq(contacts.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'contact not found')
  return c.json(serialize(row))
})

// --- Update ---
contactsRouter.patch('/:id', async (c) => {
  const body = ContactUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, wsId), eq(contacts.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'contact not found')

  const updated = await db
    .update(contacts)
    .set({
      externalId: body.external_id ?? existing.externalId,
      firstName: body.first_name ?? existing.firstName,
      lastName: body.last_name ?? existing.lastName,
      email: body.email ?? existing.email,
      phone: body.phone ?? existing.phone,
      title: body.title ?? existing.title,
      companyId: body.company_id ?? existing.companyId,
      tags: body.tags ?? existing.tags,
      data: body.data ?? existing.data,
    })
    .where(eq(contacts.id, id))
    .returning()
    .get()
  if (!updated) throw new HTTPError(500, 'contact vanished after update')

  await recordEvent(c, {
    eventType: 'contact.updated',
    entityType: 'contact',
    entityId: id,
    payload: { changed: Object.keys(body) },
  })

  return c.json(serialize(updated))
})

// --- Soft delete ---
contactsRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, wsId), eq(contacts.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'contact not found')

  await db.update(contacts).set({ deletedAt: new Date() }).where(eq(contacts.id, id)).run()
  await recordEvent(c, {
    eventType: 'contact.deleted',
    entityType: 'contact',
    entityId: id,
  })

  return c.body(null, 204)
})

// --- Restore (un-soft-delete) ---
contactsRouter.post('/:id/restore', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, wsId), eq(contacts.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'contact not found')
  if (!existing.deletedAt) return c.json(serialize(existing))

  const restored = await db
    .update(contacts)
    .set({ deletedAt: null })
    .where(eq(contacts.id, id))
    .returning()
    .get()
  await recordEvent(c, {
    eventType: 'contact.restored',
    entityType: 'contact',
    entityId: id,
  })
  return c.json(serialize(restored!))
})

// Drizzle's `sql` import is referenced indirectly via `inArray`; keep
// import marker so the bundler keeps it.
void sql
