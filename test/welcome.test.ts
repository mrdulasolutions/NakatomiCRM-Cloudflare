import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDb } from './helpers/auth'
import { applyMigrations } from './helpers/migrate'

beforeAll(async () => {
  await applyMigrations(env.DB)
})

beforeEach(async () => {
  await resetDb()
})

describe('welcome flow', () => {
  it('GET /welcome on an empty deployment renders the form', async () => {
    const res = await SELF.fetch('http://localhost/welcome')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/html/)
    const html = await res.text()
    expect(html).toContain('<form')
    expect(html).toContain('workspace slug')
  })

  it('POST /welcome creates user + workspace + API key on first run', async () => {
    const form = new URLSearchParams({
      email: 'founder@startup.test',
      password: 'verylongpassword',
      display_name: 'Founder',
      workspace_name: 'StartupCo',
      workspace_slug: 'startup',
    })
    const res = await SELF.fetch('http://localhost/welcome', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    expect(res.status).toBe(200)
    const html = await res.text()
    // Key is shown exactly once and prefixed with our format
    expect(html).toMatch(/nk_[A-Za-z0-9]{8}_[A-Za-z0-9]{43}/)
    expect(html).toContain('startup')

    // After a workspace exists, GET /welcome → 404
    const after = await SELF.fetch('http://localhost/welcome')
    expect(after.status).toBe(404)
  })

  it('POST /welcome after bootstrap → 409', async () => {
    const form = new URLSearchParams({
      email: 'a@x.com',
      password: 'verylongpassword',
      workspace_name: 'A',
      workspace_slug: 'a',
    })
    await SELF.fetch('http://localhost/welcome', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const second = await SELF.fetch('http://localhost/welcome', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    expect(second.status).toBe(409)
  })

  it('validates the slug pattern and re-renders the form with the error', async () => {
    const form = new URLSearchParams({
      email: 'a@x.com',
      password: 'verylongpassword',
      workspace_name: 'A',
      workspace_slug: 'Has Spaces',
    })
    const res = await SELF.fetch('http://localhost/welcome', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    expect(res.status).toBe(400)
    const html = await res.text()
    expect(html).toContain('<form')
    expect(html).toMatch(/dashes only|lowercase/i)
  })
})
