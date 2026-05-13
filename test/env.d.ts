/// <reference types="@cloudflare/vitest-pool-workers" />

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database
    SESSIONS: KVNamespace
    RATE_LIMIT: KVNamespace
    IDEMPOTENCY: KVNamespace
    FILES: R2Bucket
    ASSETS: Fetcher
    JWT_SECRET: string
    ADMIN_BOOTSTRAP_TOKEN?: string
  }
}

declare module '*.sql?raw' {
  const content: string
  export default content
}
