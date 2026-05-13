import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './env'

type AppEnv = { Bindings: Env }

const app = new Hono<AppEnv>()

app.use('*', logger())
app.use(
  '/v1/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key', 'X-Nakatomi-Workspace'],
    maxAge: 86400,
  }),
)

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
  const dbOk = await c.env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>()
    .then((r) => r?.ok === 1)
    .catch(() => false)
  return c.json({ db: dbOk }, dbOk ? 200 : 503)
})

app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

app.onError((err, c) => {
  console.error('unhandled', err)
  return c.json({ error: 'internal_error', message: err.message }, 500)
})

export default {
  fetch: app.fetch,

  // Queue consumer — fan-out happens in phase D.
  async queue(batch, _env, _ctx) {
    console.log(`queue=${batch.queue} size=${batch.messages.length}`)
    for (const msg of batch.messages) {
      // TODO(phase-d): route by msg.body.kind to webhook/ingest handlers
      msg.ack()
    }
  },

  // Cron — sweeps wired up in phase D/G.
  async scheduled(controller, _env, _ctx) {
    console.log(`cron cron=${controller.cron} scheduledTime=${controller.scheduledTime}`)
  },
} satisfies ExportedHandler<Env>
