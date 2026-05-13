/**
 * JWT issuance and verification using `jose`. HS256 signed with
 * `env.JWT_SECRET`. Claims:
 *   sub — user id
 *   ws  — workspace id (optional; agents can override via X-Nakatomi-Workspace)
 *   iat — issued at (seconds)
 *   exp — expiry (seconds)
 */

import { SignJWT, jwtVerify } from 'jose'

export interface AccessTokenClaims {
  sub: string
  ws?: string
  iat?: number
  exp?: number
}

export async function createAccessToken(
  secret: string,
  claims: { sub: string; ws?: string },
  ttlSeconds = 60 * 60 * 24 * 7,
): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return await new SignJWT({ ws: claims.ws })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(key)
}

export async function verifyAccessToken(
  secret: string,
  token: string,
): Promise<AccessTokenClaims | null> {
  try {
    const key = new TextEncoder().encode(secret)
    const { payload } = await jwtVerify(token, key, { algorithms: ['HS256'] })
    if (typeof payload.sub !== 'string') return null
    return {
      sub: payload.sub,
      ws: typeof payload.ws === 'string' ? payload.ws : undefined,
      iat: typeof payload.iat === 'number' ? payload.iat : undefined,
      exp: typeof payload.exp === 'number' ? payload.exp : undefined,
    }
  } catch {
    return null
  }
}
