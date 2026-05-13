import { makeApp } from './app'
import type { Env } from './env'
import { processWebhookEvent } from './jobs/webhook-delivery'

const app = makeApp()

export default {
  fetch: app.fetch,

  async queue(batch, env, _ctx) {
    if (batch.queue === 'nakatomi-webhooks') {
      for (const msg of batch.messages) {
        try {
          await processWebhookEvent(env, msg.body as Parameters<typeof processWebhookEvent>[1])
          msg.ack()
        } catch (err) {
          // Throwing out of the consumer would retry the whole batch.
          // Use per-message retry so unrelated messages still ack.
          console.error('webhook job failed; retrying', err)
          msg.retry()
        }
      }
      return
    }
    // Ingest queue lands in phase C follow-up.
    for (const msg of batch.messages) msg.ack()
  },

  async scheduled(controller, _env, _ctx) {
    console.log(`cron cron=${controller.cron} scheduledTime=${controller.scheduledTime}`)
  },
} satisfies ExportedHandler<Env>
