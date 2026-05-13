/**
 * Cursor-based pagination. Cursor encodes (createdAt-ms, id) so the next
 * page is the rows strictly older than that pair under (created_at DESC,
 * id DESC) ordering. Stable when rows have identical createdAt.
 */

import { z } from 'zod'
import { b64decode, b64encode } from './encoding'

export const PaginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  cursor: z.string().optional(),
})

export type PaginationInput = z.infer<typeof PaginationQuery>

export interface CursorPosition {
  createdAt: number
  id: string
}

export function encodeCursor(pos: CursorPosition): string {
  return b64encode(new TextEncoder().encode(JSON.stringify(pos)))
}

export function decodeCursor(cursor: string): CursorPosition | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(b64decode(cursor)))
    if (typeof parsed.createdAt === 'number' && typeof parsed.id === 'string') {
      return parsed as CursorPosition
    }
    return null
  } catch {
    return null
  }
}

export interface ListResponse<T> {
  items: T[]
  next_cursor: string | null
}

export function buildListResponse<T extends { createdAt: Date; id: string }>(
  rows: T[],
  limit: number,
  serialize: (row: T) => unknown,
): ListResponse<unknown> {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items[items.length - 1]
  const next_cursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt.getTime(), id: last.id }) : null
  return { items: items.map(serialize), next_cursor }
}
