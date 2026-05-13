import { hexEncode } from './encoding'

/** HMAC-SHA256 over `body` with the given utf-8 secret. Returns lowercase hex. */
export async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return hexEncode(new Uint8Array(sig))
}
