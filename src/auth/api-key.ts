/**
 * API key generation and parsing.
 *
 * Format: `nk_<prefix8>_<secret43>` — the prefix is an indexed lookup
 * hint stored in plaintext so we don't have to scan every key by hash.
 * Only the SHA-256 of the full key is persisted (column: api_keys.key_hash).
 * Format matches the legacy Python implementation byte-for-byte so
 * already-issued keys from the FastAPI deploy keep working.
 */

import { sha256Hex } from '../lib/encoding'

const PREFIX = 'nk'
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const PREFIX_LEN = 8
const SECRET_LEN = 43

export interface GeneratedKey {
  /** Shown to the user exactly once. */
  full: string
  /** Indexed lookup hint (api_keys.prefix). */
  prefix: string
  /** Hex SHA-256 of `full`, persisted in api_keys.key_hash. */
  hash: string
}

function base62(byteCount: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteCount))
  let out = ''
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length]
  return out
}

export async function generateApiKey(): Promise<GeneratedKey> {
  const prefix = base62(PREFIX_LEN)
  const secret = base62(SECRET_LEN)
  const full = `${PREFIX}_${prefix}_${secret}`
  return { full, prefix, hash: await sha256Hex(full) }
}

export async function hashApiKey(full: string): Promise<string> {
  return sha256Hex(full)
}

export function parseApiKeyPrefix(full: string): string | null {
  const parts = full.split('_')
  if (parts.length < 3 || parts[0] !== PREFIX) return null
  return parts[1] ?? null
}

export function looksLikeApiKey(token: string): boolean {
  return token.startsWith(`${PREFIX}_`)
}
