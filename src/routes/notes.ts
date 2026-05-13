import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, type Note, notes } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)

const NoteCreate = z.object({
  entity_type: EntityEnum,
  entity_id: z.string().uuid(),
  body: z.string().min(1),
  data: z.record(z.unknown()).optional(),
})

const NoteUpdate = z.object({
  body: z.string().min(1).optional(),
  data: z.record(z.unknown()).optional(),
})

const NoteListQuery = PaginationQuery.extend({
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  q: z.string().optional(),
})

function serialize(n: Note) {
  return {
    id: n.id,
    entity_type: n.entityType,
    entity_id: n.entityId,
    body: n.body,
    author_user_id: n.authorUserId,
    data: n.data,
    created_at: n.createdAt,
    updated_at: n.updatedAt,
    deleted_at: n.deletedAt,
  }
}

export const notesRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
notesRouter.use('*', requireAuth)

notesRouter.get('/', async (c) => {
  const q = NoteListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const where = [eq(notes.workspaceId, wsId), isNull(notes.deletedAt)]
  if (q.entity_type) where.push(eq(notes.entityType, q.entity_type))
  if (q.entity_id) where.push(eq(notes.entityId, q.entity_id))

  if (q.q) {
    const fts = await c.env.DB.prepare(
      'SELECT note_id FROM notes_fts WHERE workspace_id = ? AND notes_fts MATCH ? LIMIT 500',
    )
      .bind(wsId, q.q)
      .all<{ note_id: string }>()
    const ids = fts.results.map((r: { note_id: string }) => r.note_id)
    if (ids.length === 0) return c.json({ items: [], next_cursor: null })
    where.push(inArray(notes.id, ids))
  }

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      where.push(
        or(
          lt(notes.createdAt, new Date(pos.createdAt)),
          and(eq(notes.createdAt, new Date(pos.createdAt)), lt(notes.id, pos.id)),
        )!,
      )
    }
  }

  const rows = await db
    .select()
    .from(notes)
    .where(and(...where))
    .orderBy(desc(notes.createdAt), desc(notes.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serialize))
})

notesRouter.post('/', async (c) => {
  const body = NoteCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const created = await db
    .insert(notes)
    .values({
      workspaceId: wsId,
      entityType: body.entity_type,
      entityId: body.entity_id,
      body: body.body,
      authorUserId: c.var.principal.user?.id ?? null,
      data: body.data ?? {},
    })
    .returning()
    .get()

  await recordEvent(db, c.var.principal, {
    eventType: 'note.created',
    entityType: body.entity_type,
    entityId: body.entity_id,
    payload: { note_id: created.id },
  })

  return c.json(serialize(created), 201)
})

notesRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, wsId), eq(notes.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'note not found')
  return c.json(serialize(row))
})

notesRouter.patch('/:id', async (c) => {
  const body = NoteUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, wsId), eq(notes.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'note not found')

  const updated = await db
    .update(notes)
    .set({
      body: body.body ?? existing.body,
      data: body.data ?? existing.data,
    })
    .where(eq(notes.id, id))
    .returning()
    .get()
  return c.json(serialize(updated!))
})

notesRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(notes)
    .where(and(eq(notes.workspaceId, wsId), eq(notes.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'note not found')

  await db.update(notes).set({ deletedAt: new Date() }).where(eq(notes.id, id)).run()
  return c.body(null, 204)
})
