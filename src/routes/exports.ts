/**
 * Workspace export — JSON dump of every exportable row in the current
 * workspace. File *bytes* are not included; clients fetch them via
 * GET /v1/files/:id/download using the manifest entries in
 * `files`. Webhook secrets are redacted.
 *
 * Operational state (audit log, webhook deliveries, ingest runs,
 * idempotency) is excluded — it's deployment-bound, not portable.
 *
 * Schema is versioned. Bumping `schema_version` signals an import-side
 * migration when the shape evolves.
 */

import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { makeDb } from '../db'
import {
  activities,
  companies,
  contacts,
  customFieldDefinitions,
  dealLineItems,
  deals,
  files,
  memoryLinks,
  notes,
  pipelines,
  relationships,
  stages,
  tasks,
  timelineEvents,
  webhooks,
} from '../db/schema'
import type { Env } from '../env'
import { type AppVars, requireAuth, requireRole } from '../middleware/auth'

const EXPORT_SCHEMA_VERSION = 1

export const exportsRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
exportsRouter.use('*', requireAuth)
exportsRouter.use('*', requireRole('owner', 'admin'))

exportsRouter.get('/workspace', async (c) => {
  const includeTimeline = c.req.query('include_timeline') === 'true'
  const db = makeDb(c.env.DB)
  const ws = c.var.principal.workspace

  const [
    cfds,
    contactRows,
    companyRows,
    pipelineRows,
    stageRows,
    dealRows,
    lineItemRows,
    activityRows,
    noteRows,
    taskRows,
    relationshipRows,
    memoryLinkRows,
    fileRows,
    webhookRows,
  ] = await db.batch([
    db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.workspaceId, ws.id)),
    db.select().from(contacts).where(eq(contacts.workspaceId, ws.id)),
    db.select().from(companies).where(eq(companies.workspaceId, ws.id)),
    db.select().from(pipelines).where(eq(pipelines.workspaceId, ws.id)),
    db.select().from(stages).orderBy(asc(stages.position)),
    db.select().from(deals).where(eq(deals.workspaceId, ws.id)),
    db.select().from(dealLineItems),
    db.select().from(activities).where(eq(activities.workspaceId, ws.id)),
    db.select().from(notes).where(eq(notes.workspaceId, ws.id)),
    db.select().from(tasks).where(eq(tasks.workspaceId, ws.id)),
    db.select().from(relationships).where(eq(relationships.workspaceId, ws.id)),
    db.select().from(memoryLinks).where(eq(memoryLinks.workspaceId, ws.id)),
    db.select().from(files).where(eq(files.workspaceId, ws.id)),
    db.select().from(webhooks).where(eq(webhooks.workspaceId, ws.id)),
  ])

  // Stages query is unscoped above (cross-pipeline join is awkward in
  // a batch); filter to this workspace's pipelines now.
  const pipelineIds = new Set(pipelineRows.map((p) => p.id))
  const stagesByPipeline = new Map<string, typeof stageRows>()
  for (const s of stageRows) {
    if (!pipelineIds.has(s.pipelineId)) continue
    const arr = stagesByPipeline.get(s.pipelineId) ?? []
    arr.push(s)
    stagesByPipeline.set(s.pipelineId, arr)
  }
  const pipelinesWithStages = pipelineRows.map((p) => ({
    ...p,
    stages: stagesByPipeline.get(p.id) ?? [],
  }))

  // Deal line items scoped to this workspace's deals.
  const dealIds = new Set(dealRows.map((d) => d.id))
  const lineItemsForExport = lineItemRows.filter((l) => dealIds.has(l.dealId))

  // Redact webhook HMAC secrets.
  const webhooksRedacted = webhookRows.map((w) => ({ ...w, secret: '[redacted on export]' }))

  let timelineRows: Array<unknown> = []
  if (includeTimeline) {
    timelineRows = await db
      .select()
      .from(timelineEvents)
      .where(eq(timelineEvents.workspaceId, ws.id))
      .all()
  }

  const body = {
    schema_version: EXPORT_SCHEMA_VERSION,
    nakatomi_version: '0.1.0',
    platform: 'cloudflare-workers',
    exported_at: new Date().toISOString(),
    workspace: ws,
    custom_field_definitions: cfds,
    pipelines: pipelinesWithStages,
    contacts: contactRows,
    companies: companyRows,
    deals: dealRows,
    deal_line_items: lineItemsForExport,
    activities: activityRows,
    notes: noteRows,
    tasks: taskRows,
    relationships: relationshipRows,
    memory_links: memoryLinkRows,
    files: fileRows,
    webhooks: webhooksRedacted,
    timeline_events: timelineRows,
    counts: {
      contacts: contactRows.length,
      companies: companyRows.length,
      deals: dealRows.length,
      deal_line_items: lineItemsForExport.length,
      activities: activityRows.length,
      notes: noteRows.length,
      tasks: taskRows.length,
      relationships: relationshipRows.length,
      files: fileRows.length,
      webhooks: webhookRows.length,
      custom_field_definitions: cfds.length,
      pipelines: pipelinesWithStages.length,
      memory_links: memoryLinkRows.length,
      timeline_events: timelineRows.length,
    },
  }

  const filename = `nakatomi-${ws.slug}-${new Date().toISOString().slice(0, 10)}.json`
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/json',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  })
})
