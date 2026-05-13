/**
 * Minimal RFC-4180-ish CSV parser. Handles quoted fields, doubled
 * quotes inside quoted fields, embedded newlines, and trailing
 * newlines. Doesn't try to be a streaming parser — call sites
 * already have the full payload in memory.
 */

export interface ParsedCsv {
  headers: string[]
  rows: Array<Record<string, string>>
}

export function parseCsv(text: string): ParsedCsv {
  const records: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const ch = text[i]!
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      cell += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      row.push(cell)
      cell = ''
      i++
      continue
    }
    if (ch === '\r') {
      i++
      continue
    }
    if (ch === '\n') {
      row.push(cell)
      records.push(row)
      row = []
      cell = ''
      i++
      continue
    }
    cell += ch
    i++
  }
  // tail
  if (cell !== '' || row.length > 0) {
    row.push(cell)
    records.push(row)
  }

  if (records.length === 0) return { headers: [], rows: [] }
  const headers = (records[0] ?? []).map((h) => h.trim())
  const rows = records.slice(1).map((r) => {
    const out: Record<string, string> = {}
    for (let c = 0; c < headers.length; c++) {
      out[headers[c]!] = r[c] ?? ''
    }
    return out
  })
  return { headers, rows }
}
