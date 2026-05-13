/**
 * Fixed-window rate limit backed by KV.
 *
 * Bucket key: `rl:<identifier>:<floor(now / window)>`. The read-then-write
 * pattern is non-atomic, so a burst of concurrent requests can momentarily
 * exceed the cap by a few requests — acceptable for the soft-limiting
 * we want here. Operators needing strict caps can swap in a Durable
 * Object counter without touching call sites.
 */

export interface RateLimitResult {
  ok: boolean
  /** Remaining slots in the current window. `-1` when disabled. */
  remaining: number
  /** Seconds until the current window rolls over. `0` when ok. */
  retryAfter: number
}

export async function checkRateLimit(
  kv: KVNamespace,
  identifier: string,
  limit: number,
  windowSeconds = 60,
): Promise<RateLimitResult> {
  if (!limit || limit <= 0) return { ok: true, remaining: -1, retryAfter: 0 }

  const nowSec = Math.floor(Date.now() / 1000)
  const bucket = Math.floor(nowSec / windowSeconds)
  const key = `rl:${identifier}:${bucket}`

  const current = Number.parseInt((await kv.get(key)) ?? '0', 10) || 0
  if (current >= limit) {
    const retryAfter = windowSeconds - (nowSec % windowSeconds)
    return { ok: false, remaining: 0, retryAfter }
  }
  // expirationTtl=window*2 lets buckets self-destruct without a sweep.
  await kv.put(key, String(current + 1), { expirationTtl: windowSeconds * 2 })
  return { ok: true, remaining: Math.max(0, limit - current - 1), retryAfter: 0 }
}
