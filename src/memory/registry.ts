import type { Env } from '../env'
import { docdeployAdapter } from './adapters/docdeploy'
import { gbrainAdapter } from './adapters/gbrain'
import { supermemoryAdapter } from './adapters/supermemory'
import type { MemoryConnector } from './types'

/**
 * Loads the enabled connector set from env. A connector counts as
 * enabled when its API key (or equivalent) is present in the secret
 * store. Names are stable lowercase strings stored in MemoryLink.connector
 * — agents can refer to them directly.
 */
export function loadConnectors(env: Env): Map<string, MemoryConnector> {
  const out = new Map<string, MemoryConnector>()
  for (const adapter of [docdeployAdapter(env), supermemoryAdapter(env), gbrainAdapter(env)]) {
    if (adapter.isConfigured()) out.set(adapter.name, adapter)
  }
  return out
}

export function getConnector(env: Env, name: string): MemoryConnector | null {
  return loadConnectors(env).get(name) ?? null
}
