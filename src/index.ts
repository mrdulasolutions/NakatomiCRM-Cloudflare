import { makeApp } from './app'
import type { Env } from './env'

const app = makeApp()

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
