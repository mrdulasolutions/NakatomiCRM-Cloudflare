/** Encode bytes as base64 (standard alphabet, padded). */
export function b64encode(buf: Uint8Array): string {
  let s = ''
  for (const b of buf) s += String.fromCharCode(b)
  return btoa(s)
}

/** Decode standard-alphabet padded base64 to bytes. */
export function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Hex-encode bytes (lowercase). */
export function hexEncode(buf: Uint8Array): string {
  let s = ''
  for (const b of buf) s += b.toString(16).padStart(2, '0')
  return s
}

/** Constant-time byte-array equality. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}

/** SHA-256 the input string and return hex. */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return hexEncode(new Uint8Array(buf))
}

/** Base64url encoding (PKCE-compatible): `+` → `-`, `/` → `_`, no padding. */
export function b64urlEncode(buf: Uint8Array): string {
  return b64encode(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** PKCE S256: base64url(sha256(verifier)). */
export async function sha256B64Url(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return b64urlEncode(new Uint8Array(buf))
}
