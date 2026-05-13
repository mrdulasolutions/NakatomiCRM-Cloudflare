import { and, asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { type Pipeline, type Stage, pipelines, stages } from '../db/schema'
import type { Env } from '../env'
import { recordEvent } from '../lib/audit'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth, requireRole } from '../middleware/auth'

const StageInput = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_-]+$/),
  position: z.number().int().min(0).optional(),
  probability: z.number().min(0).max(100).optional(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
})

const PipelineCreate = z.object({
  name: z.string().min(1).max(255),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/),
  is_default: z.boolean().optional(),
  data: z.record(z.unknown()).optional(),
  stages: z.array(StageInput).min(1).optional(),
})

const PipelineUpdate = z.object({
  name: z.string().min(1).max(255).optional(),
  is_default: z.boolean().optional(),
  data: z.record(z.unknown()).optional(),
})

function serializePipeline(p: Pipeline, stageRows: Stage[] = []) {
  return {
    id: p.id,
    name: p.name,
    slug: p.slug,
    is_default: p.isDefault,
    data: p.data,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    stages: stageRows.map(serializeStage),
  }
}

function serializeStage(s: Stage) {
  return {
    id: s.id,
    pipeline_id: s.pipelineId,
    name: s.name,
    slug: s.slug,
    position: s.position,
    probability: s.probability,
    is_won: s.isWon,
    is_lost: s.isLost,
  }
}

export const pipelinesRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
pipelinesRouter.use('*', requireAuth)

pipelinesRouter.get('/', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const ps = await db.select().from(pipelines).where(eq(pipelines.workspaceId, wsId)).all()
  if (ps.length === 0) return c.json({ items: [] })

  const pIds = ps.map((p) => p.id)
  const ss = await db
    .select()
    .from(stages)
    .where(
      // multi-pipeline fetch in one go; sort by position client-side
      pIds.length === 1 ? eq(stages.pipelineId, pIds[0]!) : undefined,
    )
    .orderBy(asc(stages.position))
    .all()

  const stagesByPipeline = new Map<string, Stage[]>()
  for (const s of ss) {
    const arr = stagesByPipeline.get(s.pipelineId) ?? []
    arr.push(s)
    stagesByPipeline.set(s.pipelineId, arr)
  }

  return c.json({
    items: ps.map((p) => serializePipeline(p, stagesByPipeline.get(p.id) ?? [])),
  })
})

pipelinesRouter.post('/', requireRole('owner', 'admin'), async (c) => {
  const body = PipelineCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const existing = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, wsId), eq(pipelines.slug, body.slug)))
    .get()
  if (existing) throw new HTTPError(409, 'pipeline slug already used')

  const created = await db
    .insert(pipelines)
    .values({
      workspaceId: wsId,
      name: body.name,
      slug: body.slug,
      isDefault: body.is_default ?? false,
      data: body.data ?? {},
    })
    .returning()
    .get()

  let stageRows: Stage[] = []
  if (body.stages && body.stages.length > 0) {
    stageRows = await db
      .insert(stages)
      .values(
        body.stages.map((s, idx) => ({
          pipelineId: created.id,
          name: s.name,
          slug: s.slug,
          position: s.position ?? idx,
          probability: s.probability != null ? String(s.probability) : '0',
          isWon: s.is_won ?? false,
          isLost: s.is_lost ?? false,
        })),
      )
      .returning()
      .all()
  }

  await recordEvent(c, {
    eventType: 'pipeline.created',
    entityType: 'deal', // pipelines hang off the deal entity in the timeline
    entityId: created.id,
  })

  return c.json(serializePipeline(created, stageRows), 201)
})

pipelinesRouter.get('/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')
  const p = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, wsId), eq(pipelines.id, id)))
    .get()
  if (!p) throw new HTTPError(404, 'pipeline not found')
  const ss = await db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, p.id))
    .orderBy(asc(stages.position))
    .all()
  return c.json(serializePipeline(p, ss))
})

pipelinesRouter.patch('/:id', requireRole('owner', 'admin'), async (c) => {
  const body = PipelineUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const id = c.req.param('id')

  const existing = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, wsId), eq(pipelines.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'pipeline not found')

  const updated = await db
    .update(pipelines)
    .set({
      name: body.name ?? existing.name,
      isDefault: body.is_default ?? existing.isDefault,
      data: body.data ?? existing.data,
    })
    .where(eq(pipelines.id, id))
    .returning()
    .get()
  const ss = await db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, id))
    .orderBy(asc(stages.position))
    .all()
  return c.json(serializePipeline(updated!, ss))
})

// --- Stage CRUD nested under /pipelines/:pipelineId/stages ---

pipelinesRouter.post('/:pipelineId/stages', requireRole('owner', 'admin'), async (c) => {
  const body = StageInput.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const pipelineId = c.req.param('pipelineId')

  const p = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, wsId), eq(pipelines.id, pipelineId)))
    .get()
  if (!p) throw new HTTPError(404, 'pipeline not found')

  const dup = await db
    .select()
    .from(stages)
    .where(and(eq(stages.pipelineId, pipelineId), eq(stages.slug, body.slug)))
    .get()
  if (dup) throw new HTTPError(409, 'stage slug already used in this pipeline')

  const created = await db
    .insert(stages)
    .values({
      pipelineId,
      name: body.name,
      slug: body.slug,
      position: body.position ?? 0,
      probability: body.probability != null ? String(body.probability) : '0',
      isWon: body.is_won ?? false,
      isLost: body.is_lost ?? false,
    })
    .returning()
    .get()

  return c.json(serializeStage(created), 201)
})

pipelinesRouter.patch('/:pipelineId/stages/:id', requireRole('owner', 'admin'), async (c) => {
  const body = StageInput.partial().parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const pipelineId = c.req.param('pipelineId')
  const id = c.req.param('id')

  const p = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, wsId), eq(pipelines.id, pipelineId)))
    .get()
  if (!p) throw new HTTPError(404, 'pipeline not found')

  const existing = await db
    .select()
    .from(stages)
    .where(and(eq(stages.pipelineId, pipelineId), eq(stages.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'stage not found')

  const updated = await db
    .update(stages)
    .set({
      name: body.name ?? existing.name,
      slug: body.slug ?? existing.slug,
      position: body.position ?? existing.position,
      probability: body.probability != null ? String(body.probability) : existing.probability,
      isWon: body.is_won ?? existing.isWon,
      isLost: body.is_lost ?? existing.isLost,
    })
    .where(eq(stages.id, id))
    .returning()
    .get()
  return c.json(serializeStage(updated!))
})

pipelinesRouter.delete('/:pipelineId/stages/:id', requireRole('owner', 'admin'), async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const pipelineId = c.req.param('pipelineId')
  const id = c.req.param('id')

  const p = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, wsId), eq(pipelines.id, pipelineId)))
    .get()
  if (!p) throw new HTTPError(404, 'pipeline not found')

  const existing = await db
    .select()
    .from(stages)
    .where(and(eq(stages.pipelineId, pipelineId), eq(stages.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'stage not found')

  await db.delete(stages).where(eq(stages.id, id)).run()
  return c.body(null, 204)
})
