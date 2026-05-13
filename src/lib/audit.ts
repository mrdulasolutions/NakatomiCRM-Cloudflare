/**
 * Records a CRM mutation:
 *
 *   - writes timeline_events + audit_log atomically via db.batch()
 *   - fans out to webhook subscribers, either through the WEBHOOK_QUEUE
 *     (Cloudflare Queues; durable, batched, auto-retried) when the
 *     binding is configured, or via ctx.waitUntil() as an
 *     in-process best-effort dispatch when it isn't (e.g. local dev,
 *     tests).
 *
 * The two paths share a single processor — `processWebhookEvent` in
 * src/jobs/webhook-delivery.ts — so the contract is identical whichever
 * delivery mode is active.
 */

import type { Context } from 'hono'
import { makeDb } from '../db'
import { type EntityType, auditLog, timelineEvents } from '../db/schema'
import type { Env } from '../env'
import { type WebhookEventJob, processWebhookEvent } from '../jobs/webhook-delivery'
import type { AppVars } from '../middleware/auth'

export type RecordEventContext = Context<{ Bindings: Env; Variables: AppVars }>

interface RecordArgs {
  eventType: string
  entityType: EntityType
  entityId: string
  action?: string
  payload?: Record<string, unknown>
  ipAddress?: string | null
}

export async function recordEvent(c: RecordEventContext, args: RecordArgs): Promise<void> {
  const db = makeDb(c.env.DB)
  const p = c.var.principal
  const { eventType, entityType, entityId, action, payload = {}, ipAddress = null } = args

  await db.batch([
    db.insert(timelineEvents).values({
      workspaceId: p.workspace.id,
      entityType,
      entityId,
      eventType,
      actorUserId: p.user?.id ?? null,
      actorApiKeyId: p.apiKey?.id ?? null,
      payload,
    }),
    db.insert(auditLog).values({
      workspaceId: p.workspace.id,
      actorUserId: p.user?.id ?? null,
      actorApiKeyId: p.apiKey?.id ?? null,
      action: action ?? eventType,
      entityType,
      entityId,
      ipAddress,
      payload,
    }),
  ])

  const job: WebhookEventJob = {
    kind: 'webhook.event',
    workspaceId: p.workspace.id,
    eventType,
    entityType,
    entityId,
    payload,
  }

  if (c.env.WEBHOOK_QUEUE) {
    c.executionCtx.waitUntil(c.env.WEBHOOK_QUEUE.send(job))
  } else {
    // Best-effort in-process delivery. Errors are swallowed so a
    // misconfigured webhook can't crash the mutation that emitted the
    // event.
    c.executionCtx.waitUntil(
      processWebhookEvent(c.env, job).catch((err) => {
        console.error('webhook dispatch failed', err)
      }),
    )
  }
}
