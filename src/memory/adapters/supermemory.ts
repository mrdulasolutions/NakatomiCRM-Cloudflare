/**
 * Supermemory connector. Recall via the supermemory.ai REST API.
 * Stub-quality implementation — fills in when the API contract is
 * stabilized for our use; ships now so it shows up in the
 * /v1/memory/connectors list when SUPERMEMORY_API_KEY is set.
 */

import type { Env } from '../../env'
import type { MemoryConnector, MemoryRecallArgs, MemoryRecallResult } from '../types'

const DEFAULT_BASE_URL = 'https://api.supermemory.ai'

interface SupermemoryResponse {
  matches?: Array<{ id: string; content: string; score?: number; metadata?: Record<string, unknown> }>
}

export function supermemoryAdapter(env: Env): MemoryConnector {
  const apiKey = (env as unknown as { SUPERMEMORY_API_KEY?: string }).SUPERMEMORY_API_KEY
  const baseUrl =
    (env as unknown as { SUPERMEMORY_BASE_URL?: string }).SUPERMEMORY_BASE_URL ?? DEFAULT_BASE_URL

  return {
    name: 'supermemory',
    isConfigured: () => Boolean(apiKey),
    async recall(args: MemoryRecallArgs): Promise<MemoryRecallResult[]> {
      if (!apiKey) return []
      const res = await fetch(`${baseUrl}/v3/search`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ q: args.query, limit: args.limit }),
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) return []
      const body = (await res.json()) as SupermemoryResponse
      return (body.matches ?? []).map((m) => ({
        connector: 'supermemory',
        external_id: m.id,
        text: m.content,
        score: typeof m.score === 'number' ? m.score : 0,
        metadata: m.metadata,
      }))
    },
  }
}
