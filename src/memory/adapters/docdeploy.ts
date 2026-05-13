/**
 * DocDeploy memory connector.
 *
 * DocDeploy is the pay-per-call memory store the Nakatomi project
 * recommends as the default agent memory. Recall via the x402 REST API.
 * Webhook receipts are HMAC-signed with the DOCDEPLOY_WEBHOOK_SECRET
 * (separate from the API key) so inbound auto-linking is verifiable.
 */

import type { Env } from '../../env'
import { hmacSha256Hex } from '../../lib/hmac'
import type { MemoryConnector, MemoryRecallArgs, MemoryRecallResult } from '../types'

const DEFAULT_BASE_URL = 'https://x402.docdeploy.io'

interface DocDeployRecallResponse {
  results?: Array<{
    id?: string
    text?: string
    snippet?: string
    score?: number
    metadata?: Record<string, unknown>
  }>
}

export function docdeployAdapter(env: Env): MemoryConnector {
  const apiKey = (env as unknown as { DOCDEPLOY_API_KEY?: string }).DOCDEPLOY_API_KEY
  const webhookSecret = (env as unknown as { DOCDEPLOY_WEBHOOK_SECRET?: string }).DOCDEPLOY_WEBHOOK_SECRET
  const baseUrl =
    (env as unknown as { DOCDEPLOY_BASE_URL?: string }).DOCDEPLOY_BASE_URL ?? DEFAULT_BASE_URL

  return {
    name: 'docdeploy',
    isConfigured: () => Boolean(apiKey),
    async recall(args: MemoryRecallArgs): Promise<MemoryRecallResult[]> {
      if (!apiKey) return []
      const res = await fetch(`${baseUrl}/v1/recall_memory`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          query: args.query,
          limit: args.limit,
          metadata: {
            workspace_id: args.workspaceId,
            crm_entity_type: args.crmEntityType ?? null,
            crm_entity_id: args.crmEntityId ?? null,
          },
        }),
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) return []
      const body = (await res.json()) as DocDeployRecallResponse
      return (body.results ?? []).map((r) => ({
        connector: 'docdeploy',
        external_id: r.id ?? '',
        text: r.text ?? r.snippet ?? '',
        score: typeof r.score === 'number' ? r.score : 0,
        metadata: r.metadata,
      }))
    },
    async verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
      if (!webhookSecret) return false
      const sig = headers.get('x-docdeploy-signature')
      if (!sig) return false
      const expected = await hmacSha256Hex(webhookSecret, rawBody)
      return sig === `sha256=${expected}`
    },
  }
}
