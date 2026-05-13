import type { EntityType } from '../db/schema'

export interface MemoryRecallResult {
  /** The connector this record belongs to (matches MemoryLink.connector). */
  connector: string
  /** Connector-specific stable identifier. Persisted in MemoryLink.external_id. */
  external_id: string
  /** Snippet shown to the agent. */
  text: string
  /** 0..1 relevance score (connector-specific normalization). */
  score: number
  /** Free-form metadata returned by the connector. */
  metadata?: Record<string, unknown>
}

export interface MemoryRecallArgs {
  workspaceId: string
  query: string
  crmEntityType?: EntityType | null
  crmEntityId?: string | null
  limit: number
}

export interface MemoryConnector {
  /** Lowercase, stable connector name (matches MemoryLink.connector). */
  name: string
  /** Configured = has the API key + base URL it needs to function. */
  isConfigured(): boolean
  recall(args: MemoryRecallArgs): Promise<MemoryRecallResult[]>
  /** Optional: verify an inbound webhook signature. */
  verifyWebhook?(headers: Headers, rawBody: string): Promise<boolean>
  /** Optional: parse an inbound webhook into link candidates. */
  parseWebhook?(body: unknown): Promise<
    Array<{
      external_id: string
      text?: string
      crm_refs?: Array<{ type: EntityType; id: string }>
    }>
  >
}
