/** GBrain memory connector. Stub-quality. */

import type { Env } from '../../env'
import type { MemoryConnector, MemoryRecallArgs, MemoryRecallResult } from '../types'

const DEFAULT_BASE_URL = 'https://api.gbrain.dev'

interface GbrainResponse {
  items?: Array<{
    memory_id: string
    text: string
    similarity?: number
    metadata?: Record<string, unknown>
  }>
}

export function gbrainAdapter(env: Env): MemoryConnector {
  const apiKey = (env as unknown as { GBRAIN_API_KEY?: string }).GBRAIN_API_KEY
  const baseUrl = (env as unknown as { GBRAIN_BASE_URL?: string }).GBRAIN_BASE_URL ?? DEFAULT_BASE_URL

  return {
    name: 'gbrain',
    isConfigured: () => Boolean(apiKey),
    async recall(args: MemoryRecallArgs): Promise<MemoryRecallResult[]> {
      if (!apiKey) return []
      const res = await fetch(`${baseUrl}/v1/memories/search`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: args.query, top_k: args.limit }),
        signal: AbortSignal.timeout(8_000),
      })
      if (!res.ok) return []
      const body = (await res.json()) as GbrainResponse
      return (body.items ?? []).map((m) => ({
        connector: 'gbrain',
        external_id: m.memory_id,
        text: m.text,
        score: typeof m.similarity === 'number' ? m.similarity : 0,
        metadata: m.metadata,
      }))
    },
  }
}
