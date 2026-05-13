/**
 * Single-call helper to record a CRM mutation. Writes:
 *   - timeline_events: agent-visible append-only event log
 *   - audit_log:       internal action log with actor/ip metadata
 *
 * Batched into one D1 call via db.batch() so a mutation + its audit
 * trail land atomically.
 */

import type { DB } from '../db'
import { type EntityType, auditLog, timelineEvents } from '../db/schema'
import type { Principal } from '../middleware/auth'

interface RecordArgs {
  /** Dotted form, e.g. "contact.created", "deal.moved", "note.deleted". */
  eventType: string
  entityType: EntityType
  entityId: string
  /** Defaults to eventType. Use to distinguish audit-only events. */
  action?: string
  payload?: Record<string, unknown>
  ipAddress?: string | null
}

export async function recordEvent(
  db: DB,
  principal: Principal,
  args: RecordArgs,
): Promise<void> {
  const { eventType, entityType, entityId, action, payload = {}, ipAddress = null } = args
  await db.batch([
    db.insert(timelineEvents).values({
      workspaceId: principal.workspace.id,
      entityType,
      entityId,
      eventType,
      actorUserId: principal.user?.id ?? null,
      actorApiKeyId: principal.apiKey?.id ?? null,
      payload,
    }),
    db.insert(auditLog).values({
      workspaceId: principal.workspace.id,
      actorUserId: principal.user?.id ?? null,
      actorApiKeyId: principal.apiKey?.id ?? null,
      action: action ?? eventType,
      entityType,
      entityId,
      ipAddress,
      payload,
    }),
  ])
}
