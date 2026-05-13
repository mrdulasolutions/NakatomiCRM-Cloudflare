/**
 * Webhook delivery consumer.
 *
 * Producer: `recordEvent()` in src/lib/audit.ts emits a `WebhookEventJob`
 * to env.WEBHOOK_QUEUE per CRM mutation.
 *
 * Consumer (this file): for each event, look up active webhooks in the
 * workspace whose `events` array contains the eventType, HMAC-sign the
 * payload, POST it, and record the attempt in webhook_deliveries.
 *
 * Errors throw, which signals Cloudflare Queues to retry with backoff
 * (configured in wrangler.toml: max_retries + dead_letter_queue).
 */

import { and, eq, inArray } from 'drizzle-orm'
import { type DB, makeDb } from '../db'
import { webhookDeliveries, webhooks } from '../db/schema'
import type { Env } from '../env'
import { hmacSha256Hex } from '../lib/hmac'

export interface WebhookEventJob {
  kind: 'webhook.event'
  workspaceId: string
  eventType: string
  entityType: string
  entityId: string
  payload: Record<string, unknown>
}

const DELIVERY_TIMEOUT_MS = 15_000
const RESPONSE_BODY_CAP = 1024

interface DeliveryAttempt {
  status: 'succeeded' | 'failed'
  statusCode: number | null
  responseBody: string | null
  error: string | null
}

async function deliverOne(_env: Env, hook: { url: string; secret: string }, event: WebhookEventJob): Promise<DeliveryAttempt> {
  const body = JSON.stringify({
    event_type: event.eventType,
    entity_type: event.entityType,
    entity_id: event.entityId,
    workspace_id: event.workspaceId,
    payload: event.payload,
    delivered_at: new Date().toISOString(),
  })
  const signature = await hmacSha256Hex(hook.secret, body)

  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-nakatomi-event': event.eventType,
        'x-nakatomi-signature': `sha256=${signature}`,
        'user-agent': 'nakatomi-crm/0.1 (+cloudflare-workers)',
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    })
    const text = (await res.text()).slice(0, RESPONSE_BODY_CAP)
    return {
      status: res.ok ? 'succeeded' : 'failed',
      statusCode: res.status,
      responseBody: text,
      error: res.ok ? null : `HTTP ${res.status}`,
    }
  } catch (err) {
    return {
      status: 'failed',
      statusCode: null,
      responseBody: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export async function processWebhookEvent(env: Env, event: WebhookEventJob): Promise<{ delivered: number; failed: number }> {
  const db: DB = makeDb(env.DB)

  // Find active webhooks in the workspace.
  const subs = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.workspaceId, event.workspaceId), eq(webhooks.isActive, true)))
    .all()

  const matches = subs.filter((s) => (s.events as string[]).includes(event.eventType))
  if (matches.length === 0) return { delivered: 0, failed: 0 }

  let delivered = 0
  let failed = 0
  const errors: string[] = []

  for (const sub of matches) {
    const attempt = await deliverOne(env, { url: sub.url, secret: sub.secret }, event)

    await db
      .insert(webhookDeliveries)
      .values({
        workspaceId: event.workspaceId,
        webhookId: sub.id,
        eventType: event.eventType,
        payload: event.payload,
        status: attempt.status,
        statusCode: attempt.statusCode,
        responseBody: attempt.responseBody,
        error: attempt.error,
        attempts: 1,
        succeeded: attempt.status === 'succeeded',
      })
      .run()

    if (attempt.status === 'succeeded') {
      await db
        .update(webhooks)
        .set({ lastDeliveryAt: new Date(), failureCount: 0, lastError: null })
        .where(eq(webhooks.id, sub.id))
        .run()
      delivered++
    } else {
      await db
        .update(webhooks)
        .set({
          failureCount: sub.failureCount + 1,
          lastError: attempt.error,
          lastDeliveryAt: new Date(),
        })
        .where(eq(webhooks.id, sub.id))
        .run()
      failed++
      if (attempt.error) errors.push(`${sub.id}: ${attempt.error}`)
    }
  }

  // Throw if any delivery failed — Queues retries the whole batch on
  // throw. A more nuanced design would split successful ack from
  // failed retry; acceptable simplification for now.
  if (failed > 0) {
    throw new Error(`webhook delivery failed for ${failed}/${matches.length}: ${errors.join('; ')}`)
  }

  return { delivered, failed }
}

// Suppress import-marker for inArray (used in DLQ sweeps not yet wired here).
void inArray
