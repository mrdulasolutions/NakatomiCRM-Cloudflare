import { and, desc, eq, gte, isNull, lt, or, sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import {
  companies,
  contacts,
  deals,
  pipelines,
  stages,
  tasks,
  timelineEvents,
} from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth } from '../middleware/auth'

export const dashboardRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
dashboardRouter.use('*', requireAuth)

dashboardRouter.get('/summary', async (c) => {
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  // One D1 batch — each statement is cheap, latency adds up if serial.
  const [
    contactCount,
    companyCount,
    dealsOpen,
    dealsWon,
    dealsLost,
    pipelineValue,
    wonValue,
    tasksOpen,
    tasksOverdue,
  ] = await db.batch([
    db
      .select({ n: sql<number>`count(*)` })
      .from(contacts)
      .where(and(eq(contacts.workspaceId, wsId), isNull(contacts.deletedAt))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(companies)
      .where(and(eq(companies.workspaceId, wsId), isNull(companies.deletedAt))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(deals)
      .where(and(eq(deals.workspaceId, wsId), isNull(deals.deletedAt), eq(deals.status, 'open'))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(deals)
      .where(and(eq(deals.workspaceId, wsId), isNull(deals.deletedAt), eq(deals.status, 'won'))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(deals)
      .where(and(eq(deals.workspaceId, wsId), isNull(deals.deletedAt), eq(deals.status, 'lost'))),
    db
      .select({ total: sql<string>`coalesce(sum(cast(amount as real)), 0)` })
      .from(deals)
      .where(and(eq(deals.workspaceId, wsId), isNull(deals.deletedAt), eq(deals.status, 'open'))),
    db
      .select({ total: sql<string>`coalesce(sum(cast(amount as real)), 0)` })
      .from(deals)
      .where(and(eq(deals.workspaceId, wsId), isNull(deals.deletedAt), eq(deals.status, 'won'))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, wsId),
          isNull(tasks.deletedAt),
          or(eq(tasks.status, 'open'), eq(tasks.status, 'in_progress')),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.workspaceId, wsId),
          isNull(tasks.deletedAt),
          or(eq(tasks.status, 'open'), eq(tasks.status, 'in_progress')),
          lt(tasks.dueAt, new Date()),
        ),
      ),
  ])

  return c.json({
    contacts: contactCount[0]?.n ?? 0,
    companies: companyCount[0]?.n ?? 0,
    deals: {
      open: dealsOpen[0]?.n ?? 0,
      won: dealsWon[0]?.n ?? 0,
      lost: dealsLost[0]?.n ?? 0,
      pipeline_value: String(pipelineValue[0]?.total ?? 0),
      won_value: String(wonValue[0]?.total ?? 0),
    },
    tasks: {
      open: tasksOpen[0]?.n ?? 0,
      overdue: tasksOverdue[0]?.n ?? 0,
    },
  })
})

// GET /pipeline/:pipelineId — per-stage count + sum + weighted-sum
const PipelineParam = z.object({ pipelineId: z.string().uuid() })

dashboardRouter.get('/pipeline/:pipelineId', async (c) => {
  const { pipelineId } = PipelineParam.parse({ pipelineId: c.req.param('pipelineId') })
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  const p = await db
    .select()
    .from(pipelines)
    .where(and(eq(pipelines.workspaceId, wsId), eq(pipelines.id, pipelineId)))
    .get()
  if (!p) throw new HTTPError(404, 'pipeline not found')

  const stageRows = await db
    .select()
    .from(stages)
    .where(eq(stages.pipelineId, pipelineId))
    .all()

  const counts = await c.env.DB.prepare(
    `SELECT stage_id,
            count(*) AS n,
            coalesce(sum(cast(amount AS real)), 0) AS total
       FROM deals
      WHERE workspace_id = ?
        AND pipeline_id  = ?
        AND deleted_at IS NULL
        AND status = 'open'
      GROUP BY stage_id`,
  )
    .bind(wsId, pipelineId)
    .all<{ stage_id: string; n: number; total: number }>()

  const byStage = new Map<string, { n: number; total: number }>()
  for (const row of counts.results) byStage.set(row.stage_id, { n: row.n, total: row.total })

  const items = stageRows
    .sort((a, b) => a.position - b.position)
    .map((s) => {
      const c = byStage.get(s.id) ?? { n: 0, total: 0 }
      const prob = Number.parseFloat(s.probability) || 0
      return {
        stage_id: s.id,
        stage_slug: s.slug,
        stage_name: s.name,
        probability: prob,
        deal_count: c.n,
        deal_value: c.total,
        weighted_value: c.total * (prob / 100),
      }
    })

  const totals = items.reduce(
    (acc, it) => ({
      deal_count: acc.deal_count + it.deal_count,
      deal_value: acc.deal_value + it.deal_value,
      weighted_value: acc.weighted_value + it.weighted_value,
    }),
    { deal_count: 0, deal_value: 0, weighted_value: 0 },
  )

  return c.json({
    pipeline: { id: p.id, slug: p.slug, name: p.name },
    stages: items,
    totals,
  })
})

dashboardRouter.get('/recent-activity', async (c) => {
  const limit = Math.min(Math.max(Number.parseInt(c.req.query('limit') ?? '20', 10) || 20, 1), 200)
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id
  const rows = await db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.workspaceId, wsId))
    .orderBy(desc(timelineEvents.id))
    .limit(limit)
    .all()
  return c.json({
    items: rows.map((e) => ({
      id: e.id,
      entity_type: e.entityType,
      entity_id: e.entityId,
      event_type: e.eventType,
      occurred_at: e.occurredAt,
      payload: e.payload,
    })),
  })
})

// suppress unused-marker for or/gte; they're used inside conditional clauses
void or
void gte
