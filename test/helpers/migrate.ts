import sql0001 from '../../migrations/0001_initial.sql?raw'
import sql0002 from '../../migrations/0002_fts.sql?raw'

/**
 * Split a SQL script into individual statements.
 *
 * Handles `CREATE TRIGGER ... BEGIN ... END;` blocks where inner
 * statements are themselves `;`-terminated. Strips `--` line comments.
 * Naive but sufficient for our migration files.
 */
export function splitSql(sql: string): string[] {
  const stripped = sql.replace(/--[^\n]*/g, '')
  const out: string[] = []
  let buf = ''
  let inTrigger = false

  for (const line of stripped.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (buf) buf += '\n'
      continue
    }
    buf += `${line}\n`
    const upper = trimmed.toUpperCase()
    if (!inTrigger && upper.startsWith('CREATE TRIGGER')) {
      inTrigger = true
    }
    if (inTrigger) {
      if (upper === 'END;' || /\bEND\s*;\s*$/.test(upper)) {
        out.push(buf.trim())
        buf = ''
        inTrigger = false
      }
    } else if (trimmed.endsWith(';')) {
      out.push(buf.trim())
      buf = ''
    }
  }
  const tail = buf.trim()
  if (tail) out.push(tail)
  return out
}

/** Apply all bundled migrations to a fresh D1 database. */
export async function applyMigrations(db: D1Database): Promise<void> {
  for (const sql of [sql0001, sql0002]) {
    for (const stmt of splitSql(sql)) {
      // PRAGMA is a no-op on D1 (foreign keys are on by default), but
      // running it as a regular query throws — skip it.
      if (stmt.toUpperCase().startsWith('PRAGMA')) continue
      await db.prepare(stmt).run()
    }
  }
}
