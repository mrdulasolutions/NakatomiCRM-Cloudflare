import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { ZodError } from 'zod'
import type { Env } from './env'
import { HTTPError } from './lib/errors'
import type { AppVars } from './middleware/auth'
import { activitiesRouter } from './routes/activities'
import { authRouter } from './routes/auth'
import { companiesRouter } from './routes/companies'
import { contactsRouter } from './routes/contacts'
import { customFieldsRouter } from './routes/custom-fields'
import { dashboardRouter } from './routes/dashboard'
import { dealsRouter } from './routes/deals'
import { exportsRouter } from './routes/exports'
import { filesRouter } from './routes/files'
import { ingestRouter } from './routes/ingest'
import { notesRouter } from './routes/notes'
import { pipelinesRouter } from './routes/pipelines'
import { productsRouter } from './routes/products'
import { relationshipsRouter } from './routes/relationships'
import { tasksRouter } from './routes/tasks'
import { timelineRouter } from './routes/timeline'
import { workspacesRouter } from './routes/workspaces'

export type AppEnv = { Bindings: Env; Variables: AppVars }

const CORS_OPTS = {
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Nakatomi-Workspace'],
  maxAge: 86400,
}

export function makeApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>()

  app.use('*', logger())
  app.use('/v1/*', cors(CORS_OPTS))
  app.use('/auth/*', cors(CORS_OPTS))

  app.route('/auth', authRouter)
  app.route('/v1/workspaces', workspacesRouter)
  app.route('/v1/contacts', contactsRouter)
  app.route('/v1/companies', companiesRouter)
  app.route('/v1/pipelines', pipelinesRouter)
  app.route('/v1/products', productsRouter)
  app.route('/v1/deals', dealsRouter)
  app.route('/v1/activities', activitiesRouter)
  app.route('/v1/notes', notesRouter)
  app.route('/v1/tasks', tasksRouter)
  app.route('/v1/custom-fields', customFieldsRouter)
  app.route('/v1/relationships', relationshipsRouter)
  app.route('/v1/timeline', timelineRouter)
  app.route('/v1/dashboard', dashboardRouter)
  app.route('/v1/files', filesRouter)
  app.route('/v1/ingest', ingestRouter)
  app.route('/v1/exports', exportsRouter)

  app.get('/', (c) =>
    c.json({
      name: 'nakatomi-crm',
      version: '0.1.0',
      platform: 'cloudflare-workers',
      status: 'bootstrapping',
      docs: 'https://github.com/mrdulasolutions/NakatomiCRM-Cloudflare',
    }),
  )

  app.get('/healthz', (c) => c.text('ok'))

  app.get('/readyz', async (c) => {
    const dbOk = await c.env.DB.prepare('SELECT 1 AS ok')
      .first<{ ok: number }>()
      .then((r) => r?.ok === 1)
      .catch(() => false)
    return c.json({ db: dbOk }, dbOk ? 200 : 503)
  })

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

  app.onError((err, c) => {
    if (err instanceof HTTPError) {
      for (const [k, v] of Object.entries(err.headers)) c.header(k, v)
      return c.json({ error: 'http_error', message: err.message, ...err.extra }, err.status as 400)
    }
    if (err instanceof ZodError) {
      return c.json({ error: 'validation_error', issues: err.issues }, 400)
    }
    console.error('unhandled', err)
    return c.json({ error: 'internal_error', message: err.message }, 500)
  })

  return app
}
