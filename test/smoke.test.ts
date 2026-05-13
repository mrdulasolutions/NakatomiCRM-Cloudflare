import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('smoke', () => {
  it('GET / returns service metadata', async () => {
    const res = await SELF.fetch('http://localhost/')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string; platform: string }
    expect(body.name).toBe('nakatomi-crm')
    expect(body.platform).toBe('cloudflare-workers')
  })

  it('GET /healthz returns ok', async () => {
    const res = await SELF.fetch('http://localhost/healthz')
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ok')
  })

  it('GET /missing returns 404 JSON', async () => {
    const res = await SELF.fetch('http://localhost/does-not-exist')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('not_found')
  })
})
