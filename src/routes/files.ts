/**
 * Files — metadata in D1 (`files` table), bytes in R2 (`FILES` bucket).
 *
 * Storage key layout: `workspaces/<wsId>/files/<fileId>/<filename>`
 * — wsId-scoped so an exported R2 bucket is grouped per tenant, and the
 * fileId segment means re-uploading the same filename never collides.
 *
 * For now uploads are inline (multipart through the Worker). Workers have
 * a ~128 MB request body cap; larger files should go via presigned R2
 * URLs (follow-up).
 */

import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, type FileRecord, files } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { hexEncode } from '../lib/encoding'
import { HTTPError } from '../lib/errors'
import { PaginationQuery, buildListResponse, decodeCursor } from '../lib/pagination'
import { type AppVars, requireAuth } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)

const FileListQuery = PaginationQuery.extend({
  entity_type: EntityEnum.optional(),
  entity_id: z.string().uuid().optional(),
  include_deleted: z.coerce.boolean().default(false),
})

function serialize(f: FileRecord) {
  return {
    id: f.id,
    filename: f.filename,
    content_type: f.contentType,
    size_bytes: f.sizeBytes,
    sha256: f.sha256,
    storage_key: f.storageKey,
    entity_type: f.entityType,
    entity_id: f.entityId,
    uploaded_by_user_id: f.uploadedByUserId,
    data: f.data,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
    deleted_at: f.deletedAt,
  }
}

async function sha256OfBuffer(buf: ArrayBuffer): Promise<string> {
  return hexEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)))
}

export const filesRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
filesRouter.use('*', requireAuth)

filesRouter.get('/', async (c) => {
  const q = FileListQuery.parse(Object.fromEntries(new URL(c.req.url).searchParams))
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const where = [eq(files.workspaceId, wsId)]
  if (!q.include_deleted) where.push(isNull(files.deletedAt))
  if (q.entity_type) where.push(eq(files.entityType, q.entity_type))
  if (q.entity_id) where.push(eq(files.entityId, q.entity_id))

  if (q.cursor) {
    const pos = decodeCursor(q.cursor)
    if (pos) {
      where.push(
        or(
          lt(files.createdAt, new Date(pos.createdAt)),
          and(eq(files.createdAt, new Date(pos.createdAt)), lt(files.id, pos.id)),
        )!,
      )
    }
  }

  const rows = await db
    .select()
    .from(files)
    .where(and(...where))
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(q.limit + 1)
    .all()

  return c.json(buildListResponse(rows, q.limit, serialize))
})

/**
 * Upload a file. Body is multipart/form-data with:
 *   file         — binary (required)
 *   entity_type  — optional, must be a valid EntityType
 *   entity_id    — optional UUID
 */
filesRouter.post('/', async (c) => {
  const form = await c.req.parseBody()
  const file = form.file
  if (!(file instanceof File)) throw new HTTPError(400, 'multipart "file" field required')

  const entityType = form.entity_type as string | undefined
  const entityId = form.entity_id as string | undefined
  if (entityType && !(ENTITY_TYPES as readonly string[]).includes(entityType)) {
    throw new HTTPError(400, `entity_type must be one of: ${ENTITY_TYPES.join(', ')}`)
  }

  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const fileId = crypto.randomUUID()
  const safeName = file.name || 'unnamed'
  const storageKey = `workspaces/${wsId}/files/${fileId}/${safeName}`

  const buf = await file.arrayBuffer()
  const sha = await sha256OfBuffer(buf)

  await c.env.FILES.put(storageKey, buf, {
    httpMetadata: { contentType: file.type || 'application/octet-stream' },
    customMetadata: { workspaceId: wsId, fileId, sha256: sha },
  })

  const created = await db
    .insert(files)
    .values({
      id: fileId,
      workspaceId: wsId,
      filename: safeName,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: buf.byteLength,
      sha256: sha,
      storageKey,
      entityType: (entityType as (typeof ENTITY_TYPES)[number]) ?? null,
      entityId: entityId ?? null,
      uploadedByUserId: c.var.principal.user?.id ?? null,
    })
    .returning()
    .get()

  if (created.entityType && created.entityId) {
    await recordEvent(db, c.var.principal, {
      eventType: 'file.uploaded',
      entityType: created.entityType,
      entityId: created.entityId,
      payload: { file_id: created.id, filename: created.filename, size_bytes: created.sizeBytes },
    })
  }

  return c.json(serialize(created), 201)
})

filesRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, wsId), eq(files.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'file not found')
  return c.json(serialize(row))
})

/** Stream the file body from R2. */
filesRouter.get('/:id/download', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, wsId), eq(files.id, c.req.param('id'))))
    .get()
  if (!row || row.deletedAt) throw new HTTPError(404, 'file not found')

  const object = await c.env.FILES.get(row.storageKey)
  if (!object) throw new HTTPError(404, 'file body missing in storage')

  return new Response(object.body, {
    headers: {
      'content-type': row.contentType,
      'content-length': String(row.sizeBytes),
      'content-disposition': `attachment; filename="${encodeURIComponent(row.filename)}"`,
      etag: `"${row.sha256 ?? ''}"`,
    },
  })
})

filesRouter.delete('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(files)
    .where(and(eq(files.workspaceId, wsId), eq(files.id, id)))
    .get()
  if (!existing || existing.deletedAt) throw new HTTPError(404, 'file not found')

  // Remove R2 object first; if D1 fails after, the orphan check is the
  // sha256 column being absent. Acceptable for now.
  await c.env.FILES.delete(existing.storageKey)
  await db.update(files).set({ deletedAt: new Date() }).where(eq(files.id, id)).run()

  return c.body(null, 204)
})
