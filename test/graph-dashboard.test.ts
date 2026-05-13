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

async function seedPipeline(ctx: Awaited<ReturnType<typeof signup>>) {
  const r = await SELF.fetch('http://localhost/v1/pipelines', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Sales',
      slug: 'sales',
      is_default: true,
      stages: [
        { name: 'New', slug: 'new', position: 0, probability: 10 },
        { name: 'Qualified', slug: 'qualified', position: 1, probability: 50 },
        { name: 'Won', slug: 'won', position: 2, probability: 100, is_won: true },
      ],
    }),
  })
  return (await r.json()) as { id: string; stages: Array<{ id: string; slug: string }> }
}

async function newContact(ctx: Awaited<ReturnType<typeof signup>>): Promise<string> {
  const r = await SELF.fetch('http://localhost/v1/contacts', {
    method: 'POST',
    headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
    body: JSON.stringify({ first_name: 'A' }),
  })
  return ((await r.json()) as { id: string }).id
}

describe('custom fields', () => {
  it('creates a definition and rejects duplicates', async () => {
    const ctx = await signup()
    const create = await SELF.fetch('http://localhost/v1/custom-fields', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'contact',
        name: 'linkedin_url',
        label: 'LinkedIn',
        field_type: 'url',
      }),
    })
    expect(create.status).toBe(201)

    const dup = await SELF.fetch('http://localhost/v1/custom-fields', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        entity_type: 'contact',
        name: 'linkedin_url',
        label: 'LinkedIn 2',
        field_type: 'url',
      }),
    })
    expect(dup.status).toBe(409)

    const list = await SELF.fetch('http://localhost/v1/custom-fields?entity_type=contact', {
      headers: authHeaders(ctx),
    })
    expect(((await list.json()) as { items: unknown[] }).items.length).toBe(1)
  })
})

describe('relationships', () => {
  it('creates an edge, surfaces it via neighbors (both directions), rejects duplicates', async () => {
    const ctx = await signup()
    const aliceId = await newContact(ctx)
    const bobId = await newContact(ctx)

    const create = await SELF.fetch('http://localhost/v1/relationships', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        source_type: 'contact',
        source_id: aliceId,
        target_type: 'contact',
        target_id: bobId,
        relation_type: 'knows',
        strength: 80,
      }),
    })
    expect(create.status).toBe(201)

    const dup = await SELF.fetch('http://localhost/v1/relationships', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        source_type: 'contact',
        source_id: aliceId,
        target_type: 'contact',
        target_id: bobId,
        relation_type: 'knows',
      }),
    })
    expect(dup.status).toBe(409)

    // Alice sees the edge as outgoing
    const aliceN = await SELF.fetch(
      `http://localhost/v1/relationships/neighbors?entity_type=contact&entity_id=${aliceId}`,
      { headers: authHeaders(ctx) },
    )
    const aliceBody = (await aliceN.json()) as { items: Array<{ direction: string }> }
    expect(aliceBody.items.length).toBe(1)
    expect(aliceBody.items[0]!.direction).toBe('outgoing')

    // Bob sees the same edge as incoming
    const bobN = await SELF.fetch(
      `http://localhost/v1/relationships/neighbors?entity_type=contact&entity_id=${bobId}`,
      { headers: authHeaders(ctx) },
    )
    const bobBody = (await bobN.json()) as { items: Array<{ direction: string }> }
    expect(bobBody.items.length).toBe(1)
    expect(bobBody.items[0]!.direction).toBe('incoming')
  })
})

describe('timeline', () => {
  it('accumulates events as the user mutates the CRM', async () => {
    const ctx = await signup()
    await seedPipeline(ctx)
    const contactId = await newContact(ctx)
    // Create one deal -> deal.created event
    await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'D1',
        primary_contact_id: contactId,
        amount: '1000',
      }),
    })
    // Create one note -> note.created event on the contact
    await SELF.fetch('http://localhost/v1/notes', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ entity_type: 'contact', entity_id: contactId, body: 'hi' }),
    })

    const events = await SELF.fetch('http://localhost/v1/timeline', {
      headers: authHeaders(ctx),
    })
    const body = (await events.json()) as {
      items: Array<{ event_type: string; entity_type: string }>
    }
    const types = body.items.map((e) => e.event_type)
    expect(types).toContain('contact.created')
    expect(types).toContain('deal.created')
    expect(types).toContain('note.created')

    // Filter by entity
    const onContact = await SELF.fetch(
      `http://localhost/v1/timeline?entity_type=contact&entity_id=${contactId}`,
      { headers: authHeaders(ctx) },
    )
    const onContactBody = (await onContact.json()) as { items: unknown[] }
    // contact.created + note.created on this contact
    expect(onContactBody.items.length).toBeGreaterThanOrEqual(2)
  })
})

describe('dashboard', () => {
  it('summary reflects counts and sums', async () => {
    const ctx = await signup()
    const pipeline = await seedPipeline(ctx)
    await newContact(ctx)
    await newContact(ctx)
    // 2 open deals @ 1000, 1 won deal @ 5000
    await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'open A', amount: '1000' }),
    })
    await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'open B', amount: '1000' }),
    })
    const wonStage = pipeline.stages.find((s) => s.slug === 'won')!
    const create3 = await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'won', amount: '5000' }),
    })
    const d3 = (await create3.json()) as { id: string }
    await SELF.fetch(`http://localhost/v1/deals/${d3.id}/move`, {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ stage_id: wonStage.id }),
    })

    const r = await SELF.fetch('http://localhost/v1/dashboard/summary', {
      headers: authHeaders(ctx),
    })
    const body = (await r.json()) as {
      contacts: number
      deals: { open: number; won: number; pipeline_value: string; won_value: string }
    }
    expect(body.contacts).toBe(2)
    expect(body.deals.open).toBe(2)
    expect(body.deals.won).toBe(1)
    expect(Number(body.deals.pipeline_value)).toBe(2000)
    expect(Number(body.deals.won_value)).toBe(5000)
  })

  it('per-pipeline breakdown computes weighted value', async () => {
    const ctx = await signup()
    const pipeline = await seedPipeline(ctx)
    // Two open deals in the default first stage (New, probability 10)
    await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'A', amount: '1000' }),
    })
    await SELF.fetch('http://localhost/v1/deals', {
      method: 'POST',
      headers: { ...authHeaders(ctx), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'B', amount: '2000' }),
    })

    const r = await SELF.fetch(`http://localhost/v1/dashboard/pipeline/${pipeline.id}`, {
      headers: authHeaders(ctx),
    })
    const body = (await r.json()) as {
      stages: Array<{ stage_slug: string; deal_count: number; deal_value: number; weighted_value: number }>
      totals: { deal_count: number; deal_value: number; weighted_value: number }
    }
    const newStage = body.stages.find((s) => s.stage_slug === 'new')!
    expect(newStage.deal_count).toBe(2)
    expect(newStage.deal_value).toBe(3000)
    expect(newStage.weighted_value).toBeCloseTo(300, 1) // 3000 * 0.10
    expect(body.totals.deal_count).toBe(2)
  })
})
