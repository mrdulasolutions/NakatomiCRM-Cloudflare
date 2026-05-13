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
  // Phase D — wired up when queue handlers land
  WEBHOOK_QUEUE?: Queue<WebhookJob>
  INGEST_QUEUE?: Queue<IngestJob>
  // Phase F — wired up when memory/AI features land
  VECTORS?: VectorizeIndex
  AI?: Ai
  // Secrets (set via `wrangler secret put`)
  JWT_SECRET: string
  ADMIN_BOOTSTRAP_TOKEN?: string
}

export interface WebhookJob {
  kind: 'webhook.delivery'
  workspaceId: string
  endpointId: string
  eventId: string
  attempt: number
}

export interface IngestJob {
  kind: 'ingest.run'
  workspaceId: string
  adapter: string
  payload: Record<string, unknown>
}

export type QueueJob = WebhookJob | IngestJob
