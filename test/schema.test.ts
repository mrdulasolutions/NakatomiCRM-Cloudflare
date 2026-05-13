import { env } from 'cloudflare:test'
import { eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { makeDb } from '../src/db'
import { contacts, workspaces } from '../src/db/schema'
import { applyMigrations } from './helpers/migrate'

beforeAll(async () => {
  await applyMigrations(env.DB)
})

const EXPECTED_TABLES = [
  'activities',
  'api_keys',
  'audit_log',
  'calendar_feeds',
  'companies',
  'contacts',
  'custom_field_definitions',
  'deal_line_items',
  'deals',
  'email_configs',
  'files',
  'ingest_runs',
  'memberships',
  'memory_links',
  'notes',
  'oauth_clients',
  'oauth_codes',
  'pipelines',
  'products',
  'relationships',
  'stages',
  'tasks',
  'timeline_events',
  'users',
  'webhook_deliveries',
  'webhooks',
  'workspaces',
]

describe('schema', () => {
  it('creates every base table', async () => {
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND name NOT LIKE 'sqlite_%'
         AND name NOT LIKE '_cf_%'
         AND name NOT LIKE 'd1_%'
         AND name NOT LIKE '%_fts%'
         AND name NOT LIKE '%_data'
         AND name NOT LIKE '%_idx'
         AND name NOT LIKE '%_docsize'
         AND name NOT LIKE '%_config'
         AND name NOT LIKE '%_content'
       ORDER BY name`,
    ).all<{ name: string }>()
    const names = rows.results.map((r: { name: string }) => r.name)
    for (const t of EXPECTED_TABLES) {
      expect(names, `missing table ${t}`).toContain(t)
    }
  })

  it('creates four FTS5 virtual tables', async () => {
    const rows = await env.DB.prepare(
      `SELECT name FROM sqlite_master
       WHERE type='table'
         AND name IN ('contacts_fts','companies_fts','notes_fts','deals_fts')`,
    ).all<{ name: string }>()
    expect(rows.results.map((r: { name: string }) => r.name).sort()).toEqual([
      'companies_fts',
      'contacts_fts',
      'deals_fts',
      'notes_fts',
    ])
  })

  it('round-trips a workspace via Drizzle', async () => {
    const db = makeDb(env.DB)
    const inserted = await db
      .insert(workspaces)
      .values({ name: 'Acme', slug: 'acme', data: { tier: 'pro' } })
      .returning()
      .get()
    expect(inserted.name).toBe('Acme')
    expect(inserted.data).toEqual({ tier: 'pro' })
    expect(inserted.createdAt).toBeInstanceOf(Date)

    const fetched = await db.select().from(workspaces).where(eq(workspaces.id, inserted.id)).get()
    expect(fetched?.slug).toBe('acme')
  })

  it('FTS triggers index new contacts on insert', async () => {
    const wsId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)')
      .bind(wsId, 'FTS Test', `fts-${wsId.slice(0, 8)}`)
      .run()

    const cId = crypto.randomUUID()
    await env.DB.prepare(
      'INSERT INTO contacts (id, workspace_id, first_name, last_name, email) VALUES (?, ?, ?, ?, ?)',
    )
      .bind(cId, wsId, 'Alice', 'Smith', 'alice@example.com')
      .run()

    const hit = await env.DB.prepare(
      "SELECT contact_id FROM contacts_fts WHERE contacts_fts MATCH 'alice'",
    ).all<{ contact_id: string }>()
    expect(hit.results.map((r: { contact_id: string }) => r.contact_id)).toContain(cId)
  })

  it('CHECK constraint on enum columns rejects unknown values', async () => {
    const wsId = crypto.randomUUID()
    await env.DB.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)')
      .bind(wsId, 'CHK', `chk-${wsId.slice(0, 8)}`)
      .run()
    await expect(
      env.DB.prepare(
        'INSERT INTO memberships (id, workspace_id, user_id, role) VALUES (?, ?, ?, ?)',
      )
        .bind(crypto.randomUUID(), wsId, crypto.randomUUID(), 'superuser')
        .run(),
    ).rejects.toThrow()
  })

  it('soft-delete pattern: deleted_at filter via Drizzle', async () => {
    const db = makeDb(env.DB)
    const ws = await db
      .insert(workspaces)
      .values({ name: 'soft', slug: `soft-${crypto.randomUUID().slice(0, 8)}` })
      .returning()
      .get()

    const c = await db
      .insert(contacts)
      .values({ workspaceId: ws.id, firstName: 'Bob', email: 'bob@example.com' })
      .returning()
      .get()
    expect(c.deletedAt).toBeNull()

    await db.update(contacts).set({ deletedAt: new Date() }).where(eq(contacts.id, c.id)).run()
    const after = await db.select().from(contacts).where(eq(contacts.id, c.id)).get()
    expect(after?.deletedAt).toBeInstanceOf(Date)
  })
})
