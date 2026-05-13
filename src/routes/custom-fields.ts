import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ENTITY_TYPES, type CustomFieldDefinition, customFieldDefinitions } from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth, requireRole } from '../middleware/auth'

const EntityEnum = z.enum(ENTITY_TYPES)
const FIELD_TYPES = ['string', 'number', 'bool', 'date', 'url', 'email', 'select', 'text'] as const

const CfdCreate = z.object({
  entity_type: EntityEnum,
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/, 'name must be snake_case'),
  label: z.string().min(1).max(255),
  field_type: z.enum(FIELD_TYPES),
  required: z.boolean().optional(),
  default_value: z.unknown().optional(),
  options: z.array(z.string()).optional(),
  description: z.string().optional(),
})

const CfdUpdate = CfdCreate.partial().omit({ entity_type: true, name: true })

function serialize(d: CustomFieldDefinition) {
  return {
    id: d.id,
    entity_type: d.entityType,
    name: d.name,
    label: d.label,
    field_type: d.fieldType,
    required: d.required,
    default_value: d.defaultValue,
    options: d.options,
    description: d.description,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  }
}

export const customFieldsRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
customFieldsRouter.use('*', requireAuth)

customFieldsRouter.get('/', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const entityType = c.req.query('entity_type') as
    | (typeof ENTITY_TYPES)[number]
    | undefined

  const where = [eq(customFieldDefinitions.workspaceId, wsId)]
  if (entityType) where.push(eq(customFieldDefinitions.entityType, entityType))

  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(...where))
    .all()
  return c.json({ items: rows.map(serialize) })
})

customFieldsRouter.post('/', requireRole('owner', 'admin'), async (c) => {
  const body = CfdCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const dup = await db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(
        eq(customFieldDefinitions.workspaceId, wsId),
        eq(customFieldDefinitions.entityType, body.entity_type),
        eq(customFieldDefinitions.name, body.name),
      ),
    )
    .get()
  if (dup) throw new HTTPError(409, `custom field "${body.name}" already exists for ${body.entity_type}`)

  const created = await db
    .insert(customFieldDefinitions)
    .values({
      workspaceId: wsId,
      entityType: body.entity_type,
      name: body.name,
      label: body.label,
      fieldType: body.field_type,
      required: body.required ?? false,
      // default_value/options are NOT NULL with SQL defaults ('{}' / '[]');
      // pass undefined so Drizzle omits the column from the INSERT.
      defaultValue: body.default_value,
      options: body.options,
      description: body.description ?? null,
    })
    .returning()
    .get()
  return c.json(serialize(created), 201)
})

customFieldsRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const row = await db
    .select()
    .from(customFieldDefinitions)
    .where(
      and(eq(customFieldDefinitions.workspaceId, wsId), eq(customFieldDefinitions.id, c.req.param('id'))),
    )
    .get()
  if (!row) throw new HTTPError(404, 'custom field not found')
  return c.json(serialize(row))
})

customFieldsRouter.patch('/:id', requireRole('owner', 'admin'), async (c) => {
  const body = CfdUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, wsId), eq(customFieldDefinitions.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'custom field not found')

  const updated = await db
    .update(customFieldDefinitions)
    .set({
      label: body.label ?? existing.label,
      fieldType: body.field_type ?? existing.fieldType,
      required: body.required ?? existing.required,
      defaultValue: body.default_value === undefined ? existing.defaultValue : body.default_value,
      options: body.options ?? existing.options,
      description: body.description ?? existing.description,
    })
    .where(eq(customFieldDefinitions.id, id))
    .returning()
    .get()
  return c.json(serialize(updated!))
})

customFieldsRouter.delete('/:id', requireRole('owner', 'admin'), async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')
  const existing = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.workspaceId, wsId), eq(customFieldDefinitions.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'custom field not found')
  await db.delete(customFieldDefinitions).where(eq(customFieldDefinitions.id, id)).run()
  return c.body(null, 204)
})
