import type { WebhookEventJob } from './jobs/webhook-delivery'

export interface Env {
  // D1
  DB: D1Database
  // KV
  SESSIONS: KVNamespace
  RATE_LIMIT: KVNamespace
  IDEMPOTENCY: KVNamespace
  // R2
  FILES: R2Bucket
  // Static assets binding
  ASSETS: Fetcher
  // Queues — webhook fanout enqueues here when configured; otherwise
  // audit.ts falls back to ctx.waitUntil + in-process delivery.
  WEBHOOK_QUEUE?: Queue<WebhookEventJob>
  INGEST_QUEUE?: Queue<IngestJob>
  // Phase F — wired up when memory/AI features land
  VECTORS?: VectorizeIndex
  AI?: Ai
  // Secrets (set via `wrangler secret put`)
  JWT_SECRET: string
  ADMIN_BOOTSTRAP_TOKEN?: string
}

export interface IngestJob {
  kind: 'ingest.run'
  workspaceId: string
  adapter: string
  payload: Record<string, unknown>
}

export type QueueJob = WebhookEventJob | IngestJob
