/**
 * Calendar feed CRUD + on-demand sync.
 *
 * Each feed is an iCal (.ics) URL — Google Calendar, Microsoft, Apple,
 * Fastmail, anything that publishes a feed. The poller fetches the
 * feed, parses VEVENTs, matches attendees to existing contacts by email,
 * and creates or updates a `meeting`-kind activity per event. Uses
 * `seen_uids` (ics UID → activity id) to dedupe across re-syncs.
 *
 * ETag handling honors If-None-Match so re-syncing a stable feed is a
 * cheap 304.
 */

import { and, eq, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { type ICalEvent, parseIcs } from '../calendar/ical'
import { makeDb } from '../db'
import { type CalendarFeed, activities, calendarFeeds, contacts } from '../db/schema'
import type { Env } from '../env'
import { HTTPError } from '../lib/errors'
import { type AppVars, requireAuth } from '../middleware/auth'

const FeedCreate = z.object({
  name: z.string().min(1).max(255),
  ics_url: z.string().url().max(2048),
  is_active: z.boolean().optional(),
})

const FeedUpdate = FeedCreate.partial()

function serialize(f: CalendarFeed) {
  return {
    id: f.id,
    name: f.name,
    ics_url: f.icsUrl,
    is_active: f.isActive,
    last_polled_at: f.lastPolledAt,
    last_etag: f.lastEtag,
    data: f.data,
    created_at: f.createdAt,
    updated_at: f.updatedAt,
  }
}

export const calendarRouter = new Hono<{ Bindings: Env; Variables: AppVars }>()
calendarRouter.use('*', requireAuth)

calendarRouter.get('/feeds', async (c) => {
  const db = makeDb(c.env.DB)
  const rows = await db
    .select()
    .from(calendarFeeds)
    .where(eq(calendarFeeds.workspaceId, c.var.principal.workspace.id))
    .all()
  return c.json({ items: rows.map(serialize) })
})

calendarRouter.post('/feeds', async (c) => {
  const body = FeedCreate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const created = await db
    .insert(calendarFeeds)
    .values({
      workspaceId: c.var.principal.workspace.id,
      name: body.name,
      icsUrl: body.ics_url,
      isActive: body.is_active ?? true,
    })
    .returning()
    .get()
  return c.json(serialize(created), 201)
})

calendarRouter.get('/feeds/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const row = await db
    .select()
    .from(calendarFeeds)
    .where(
      and(
        eq(calendarFeeds.workspaceId, c.var.principal.workspace.id),
        eq(calendarFeeds.id, c.req.param('id')),
      ),
    )
    .get()
  if (!row) throw new HTTPError(404, 'feed not found')
  return c.json(serialize(row))
})

calendarRouter.patch('/feeds/:id', async (c) => {
  const body = FeedUpdate.parse(await c.req.json())
  const db = makeDb(c.env.DB)
  const id = c.req.param('id')
  const wsId = c.var.principal.workspace.id

  const existing = await db
    .select()
    .from(calendarFeeds)
    .where(and(eq(calendarFeeds.workspaceId, wsId), eq(calendarFeeds.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'feed not found')

  const updated = await db
    .update(calendarFeeds)
    .set({
      name: body.name ?? existing.name,
      icsUrl: body.ics_url ?? existing.icsUrl,
      isActive: body.is_active ?? existing.isActive,
    })
    .where(eq(calendarFeeds.id, id))
    .returning()
    .get()
  return c.json(serialize(updated!))
})

calendarRouter.delete('/feeds/:id', async (c) => {
  const db = makeDb(c.env.DB)
  const id = c.req.param('id')
  const wsId = c.var.principal.workspace.id

  const existing = await db
    .select()
    .from(calendarFeeds)
    .where(and(eq(calendarFeeds.workspaceId, wsId), eq(calendarFeeds.id, id)))
    .get()
  if (!existing) throw new HTTPError(404, 'feed not found')

  await db.delete(calendarFeeds).where(eq(calendarFeeds.id, id)).run()
  return c.body(null, 204)
})

calendarRouter.post('/feeds/:id/sync', async (c) => {
  const db = makeDb(c.env.DB)
  const id = c.req.param('id')
  const wsId = c.var.principal.workspace.id

  const feed = await db
    .select()
    .from(calendarFeeds)
    .where(and(eq(calendarFeeds.workspaceId, wsId), eq(calendarFeeds.id, id)))
    .get()
  if (!feed) throw new HTTPError(404, 'feed not found')

  const result = await syncFeed(c.env, feed)
  return c.json(result)
})

// ---------------------------------------------------------------------------
// Shared sync logic — also called by the scheduled() cron in src/index.ts.
// ---------------------------------------------------------------------------

export interface SyncResult {
  feed_id: string
  fetched: boolean
  created: number
  updated: number
  skipped: number
  events_seen: number
  http_status: number
}

export async function syncFeed(env: Env, feed: CalendarFeed): Promise<SyncResult> {
  const db = makeDb(env.DB)
  const headers: Record<string, string> = {
    accept: 'text/calendar, application/ics, text/plain',
    'user-agent': 'nakatomi-crm/0.1 (+cloudflare-workers)',
  }
  if (feed.lastEtag) headers['if-none-match'] = feed.lastEtag

  const res = await fetch(feed.icsUrl, { headers, signal: AbortSignal.timeout(20_000) })
  if (res.status === 304) {
    return {
      feed_id: feed.id,
      fetched: false,
      created: 0,
      updated: 0,
      skipped: 0,
      events_seen: 0,
      http_status: 304,
    }
  }
  if (!res.ok) {
    throw new HTTPError(502, `feed fetch failed: HTTP ${res.status}`)
  }

  const text = await res.text()
  const events = parseIcs(text)

  const seen = (feed.seenUids as Record<string, string>) ?? {}
  const seenKeys = Object.keys(seen)
  const existingActivities =
    seenKeys.length > 0
      ? await db
          .select()
          .from(activities)
          .where(inArray(activities.id, Object.values(seen)))
          .all()
      : []
  const existingById = new Map(existingActivities.map((a) => [a.id, a]))

  let created = 0
  let updated = 0
  let skipped = 0

  for (const event of events) {
    const contactIds = await matchAttendees(db, feed.workspaceId, event)
    const meetingPayload = {
      ics_uid: event.uid,
      ics_url: feed.icsUrl,
      start: event.start,
      end: event.end,
      organizer: event.organizer,
      attendees: event.attendees,
      contact_ids: contactIds,
    }
    const existingId = seen[event.uid]
    const existing = existingId ? existingById.get(existingId) : undefined

    if (existing) {
      const same =
        existing.subject === event.summary && existing.body === event.description
      if (!same) {
        await db
          .update(activities)
          .set({
            subject: event.summary || existing.subject,
            body: event.description || existing.body,
            data: meetingPayload,
          })
          .where(eq(activities.id, existing.id))
          .run()
        updated++
      } else {
        skipped++
      }
      continue
    }

    const newRow = await db
      .insert(activities)
      .values({
        workspaceId: feed.workspaceId,
        kind: 'meeting',
        subject: event.summary,
        body: event.description,
        occurredAt: parseIcsTime(event.start) ?? new Date(),
        entityType: contactIds[0] ? 'contact' : null,
        entityId: contactIds[0] ?? null,
        data: meetingPayload,
      })
      .returning()
      .get()
    seen[event.uid] = newRow.id
    created++
  }

  const etag = res.headers.get('etag') ?? feed.lastEtag
  await db
    .update(calendarFeeds)
    .set({ lastPolledAt: new Date(), lastEtag: etag, seenUids: seen })
    .where(eq(calendarFeeds.id, feed.id))
    .run()

  return {
    feed_id: feed.id,
    fetched: true,
    created,
    updated,
    skipped,
    events_seen: events.length,
    http_status: res.status,
  }
}

async function matchAttendees(
  db: ReturnType<typeof makeDb>,
  workspaceId: string,
  event: ICalEvent,
): Promise<string[]> {
  if (event.attendees.length === 0) return []
  const lower = event.attendees.map((a) => a.toLowerCase())
  const rows = await db
    .select()
    .from(contacts)
    .where(and(eq(contacts.workspaceId, workspaceId), inArray(contacts.email, lower)))
    .all()
  return rows.map((r) => r.id)
}

function parseIcsTime(s: string): Date | null {
  // Accept YYYYMMDDTHHMMSSZ or YYYYMMDD (date-only).
  if (/^\d{8}T\d{6}Z$/.test(s)) {
    return new Date(
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`,
    )
  }
  if (/^\d{8}$/.test(s)) {
    return new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`)
  }
  return null
}
