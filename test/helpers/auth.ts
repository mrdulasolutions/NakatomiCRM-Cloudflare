import { SELF, env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { generateApiKey } from '../../src/auth/api-key'
import { makeDb } from '../../src/db'
import { apiKeys, workspaces } from '../../src/db/schema'

export async function resetDb(): Promise<void> {
  // Order matters: child tables first to avoid FK conflicts even with
  // ON DELETE CASCADE (SQLite enforces CASCADE but order keeps it tidy
  // for tables without explicit FKs).
  for (const table of [
    'audit_log',
    'timeline_events',
    'webhook_deliveries',
    'oauth_codes',
    'oauth_clients',
    'memory_links',
    'ingest_runs',
    'deal_line_items',
    'webhooks',
    'tasks',
    'notes',
    'activities',
    'relationships',
    'files',
    'custom_field_definitions',
    'calendar_feeds',
    'email_configs',
    'deals',
    'stages',
    'pipelines',
    'products',
    'contacts',
    'companies',
    'api_keys',
    'memberships',
    'workspaces',
    'users',
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run()
  }
}

export interface AuthedContext {
  token: string
  workspace_id: string
  workspace_slug: string
  user_id: string
}

export async function signup(body?: Partial<Record<string, unknown>>): Promise<AuthedContext> {
  const merged = {
    email: 'alice@example.com',
    password: 'verylongpassword',
    display_name: 'Alice',
    workspace_name: 'Acme',
    workspace_slug: 'acme',
    ...body,
  }
  const res = await SELF.fetch('http://localhost/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(merged),
  })
  if (!res.ok) throw new Error(`signup failed: ${res.status} ${await res.text()}`)
  const j = (await res.json()) as {
    access_token: string
    user_id: string
    workspace_id: string
    workspace_slug: string
  }
  return {
    token: j.access_token,
    workspace_id: j.workspace_id,
    workspace_slug: j.workspace_slug,
    user_id: j.user_id,
  }
}

/** Mint an API key directly in the DB for an existing workspace. */
export async function mintApiKey(
  workspaceId: string,
  role: 'owner' | 'admin' | 'member' | 'readonly' = 'admin',
): Promise<string> {
  const db = makeDb(env.DB)
  const ws = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).get()
  if (!ws) throw new Error('workspace not found')
  const generated = await generateApiKey()
  await db
    .insert(apiKeys)
    .values({
      workspaceId,
      name: 'test-key',
      prefix: generated.prefix,
      keyHash: generated.hash,
      role,
    })
    .run()
  return generated.full
}

export function authHeaders(ctx: AuthedContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.token}`, 'x-nakatomi-workspace': ctx.workspace_slug }
}
