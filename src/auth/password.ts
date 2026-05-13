/**
 * Password hashing via PBKDF2-HMAC-SHA256 over WebCrypto. Workers-native,
 * no native binaries (bcrypt won't run on Workers).
 *
 * Hash format: `pbkdf2_sha256$<iterations>$<salt-b64>$<hash-b64>`
 * Self-describing so a future bump in iterations or algorithm can run
 * alongside existing hashes.
 *
 * 600,000 iterations matches OWASP's 2023 recommendation for PBKDF2-SHA256.
 */

import { b64decode, b64encode, timingSafeEqual } from '../lib/encoding'

const SCHEME = 'pbkdf2_sha256'
const PBKDF2_ITERATIONS = 600_000
const SALT_BYTES = 16
const HASH_BYTES = 32

async function pbkdf2(plain: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(plain),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    HASH_BYTES * 8,
  )
  return new Uint8Array(bits)
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await pbkdf2(plain, salt, PBKDF2_ITERATIONS)
  return `${SCHEME}$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(hash)}`
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 4 || parts[0] !== SCHEME) return false
  const iterations = Number.parseInt(parts[1]!, 10)
  if (!Number.isFinite(iterations) || iterations < 1) return false
  const salt = b64decode(parts[2]!)
  const expected = b64decode(parts[3]!)
  const actual = await pbkdf2(plain, salt, iterations)
  return timingSafeEqual(actual, expected)
}
