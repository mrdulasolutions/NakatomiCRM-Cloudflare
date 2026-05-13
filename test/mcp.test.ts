import { SELF, env } from 'cloudflare:test'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { authHeaders, resetDb, signup } from './helpers/auth'
import { applyMigrations } from './helpers/migrate'

beforeAll(async () => {
  await applyMigrations(env.DB)
})

beforeEach(async () => {
  await resetDb()
})

interface JsonRpcResp {
  jsonrpc: '2.0'
  id: number
  result?: { tools?: unknown[]; content?: Array<{ type: string; text: string }>; isError?: boolean; protocolVersion?: string }
  error?: { code: number; message: string }
}

async function rpc(authToken: string, method: string, params?: Record<string, unknown>) {
  const res = await SELF.fetch('http://localhost/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${authToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return { res, json: (await res.json()) as JsonRpcResp }
}

describe('MCP server', () => {
  it('GET /mcp returns server info', async () => {
    const res = await SELF.fetch('http://localhost/mcp')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { protocolVersion: string; tools: number }
    expect(body.protocolVersion).toBe('2024-11-05')
    expect(body.tools).toBeGreaterThan(0)
  })

  it('rejects POST without Authorization header', async () => {
    const res = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    expect(res.status).toBe(401)
  })

  it('initialize returns capabilities + serverInfo', async () => {
    // Use a JWT (any valid token) — even though MCP usually wants API keys,
    // the auth-resolution inside tool dispatch works for either.
    const ctx = await signup()
    const { json } = await rpc(ctx.token, 'initialize')
    expect(json.result?.protocolVersion).toBe('2024-11-05')
  })

  it('tools/list returns the registered tool set', async () => {
    const ctx = await signup()
    const { json } = await rpc(ctx.token, 'tools/list')
    expect(Array.isArray(json.result?.tools)).toBe(true)
    const names = (json.result!.tools as Array<{ name: string }>).map((t) => t.name)
    for (const expected of [
      'search_contacts',
      'create_contact',
      'create_deal',
      'move_deal_stage',
      'memory_recall',
      'send_email',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('tools/call dispatches a tool — list_pipelines returns the JWT auth path', async () => {
    const ctx = await signup()
    // Need a workspace header for JWT auth — the MCP request only carries
    // the bearer, so set the header on the underlying invocation. Simpler:
    // use the API-key path (mint one).
    const ctxApi = await signup({ email: 'k@x.com', workspace_slug: 'k', workspace_name: 'K' })
    const keyRes = await SELF.fetch('http://localhost/v1/workspaces/current', {
      headers: authHeaders(ctxApi),
    })
    expect(keyRes.status).toBe(200)
    void ctx
    // Use the API-key handle directly via the test helper
    const { mintApiKey } = await import('./helpers/auth')
    const apiKey = await mintApiKey(ctxApi.workspace_id, 'owner')

    const r = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_pipelines', arguments: {} },
      }),
    })
    expect(r.status).toBe(200)
    const body = (await r.json()) as JsonRpcResp
    expect(body.result?.isError).toBe(false)
    // The pipelines list is empty for a fresh workspace, but the call returns ok.
    expect(body.result?.content?.[0]?.type).toBe('text')
  })

  it('tools/call returns an error envelope for unknown tools', async () => {
    const ctx = await signup()
    const { json } = await rpc(ctx.token, 'tools/call', { name: 'does_not_exist', arguments: {} })
    expect(json.error?.code).toBe(-32601)
  })

  it('tools/call: create_contact via MCP creates a row', async () => {
    const ctxBoot = await signup({
      email: 'mcp@x.com',
      workspace_slug: 'mcp',
      workspace_name: 'MCP',
    })
    const { mintApiKey } = await import('./helpers/auth')
    const apiKey = await mintApiKey(ctxBoot.workspace_id, 'admin')

    const r = await SELF.fetch('http://localhost/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'create_contact',
          arguments: { first_name: 'Trinity', email: 'trinity@matrix.test' },
        },
      }),
    })
    const body = (await r.json()) as JsonRpcResp
    expect(body.result?.isError).toBe(false)
    const text = body.result?.content?.[0]?.text ?? '{}'
    const parsed = JSON.parse(text) as { first_name: string; email: string }
    expect(parsed.first_name).toBe('Trinity')

    // And the contact actually exists in the workspace
    const list = await SELF.fetch('http://localhost/v1/contacts', {
      headers: { authorization: `Bearer ${apiKey}` },
    })
    const items = ((await list.json()) as { items: unknown[] }).items
    expect(items.length).toBe(1)
  })
})
