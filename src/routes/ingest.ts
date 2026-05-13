import { Hono } from 'hono'
import { z } from 'zod'
import { makeDb } from '../db'
import { ingestRuns } from '../db/schema'
import type { Env } from '../env'
import { parseCsv } from '../lib/csv'
import { type IngestKind, runIngest } from '../lib/ingest'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth } from '../middleware/auth'

const KindEnum = z.enum(['contact', 'company', 'deal'])

const IngestRequest = z.object({
  source: z.string().min(1).max(64),
  kind: KindEnum,
  format: z.enum(['json', 'csv']).default('json'),
  /** json: array of record objects | csv: raw CSV string */
  payload: z.union([z.array(z.record(z.unknown())), z.string()]),
})

export const ingestRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
ingestRouter.use('*', requireAuth)

ingestRouter.post('/', async (c) => {
  const body = IngestRequest.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const wsId = c.var.principal.workspace.id

  let rows: Array<Record<string, unknown>> = []
  if (body.format === 'json') {
    if (!Array.isArray(body.payload)) {
      throw new HTTPError(400, 'json format requires payload to be an array of records')
    }
    rows = body.payload
  } else {
    if (typeof body.payload !== 'string') {
      throw new HTTPError(400, 'csv format requires payload to be a string')
    }
    const parsed = parseCsv(body.payload)
    rows = parsed.rows
  }

  const result = await runIngest(db, wsId, body.kind as IngestKind, rows)

  const run = await db
    .insert(ingestRuns)
    .values({
      workspaceId: wsId,
      source: body.source,
      format: body.format,
      actorUserId: c.var.principal.user?.id ?? null,
      actorApiKeyId: c.var.principal.apiKey?.id ?? null,
      recordCount: result.record_count,
      createdCount: result.created_ids.length,
      updatedCount: result.updated_ids.length,
      errorCount: result.error_count,
      diagnostics: { items: result.diagnostics },
    })
    .returning()
    .get()

  return c.json({
    run_id: run.id,
    source: body.source,
    kind: body.kind,
    format: body.format,
    record_count: result.record_count,
    created: result.created_ids.length,
    updated: result.updated_ids.length,
    errors: result.error_count,
    created_ids: result.created_ids,
    updated_ids: result.updated_ids,
    diagnostics: result.diagnostics,
  })
})
