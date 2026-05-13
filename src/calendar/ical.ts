/**
 * Minimal RFC 5545 (iCalendar) parser. Extracts every VEVENT with the
 * fields Nakatomi cares about: uid, summary, description, start, end,
 * organizer, attendees.
 *
 * Handles line unfolding (lines beginning with whitespace continue the
 * previous one), parameter-stripped property names (DTSTART;VALUE=DATE →
 * DTSTART), and ATTENDEE/ORGANIZER mailto: prefixes.
 *
 * Doesn't try to be a full implementation — no RRULE expansion, no
 * timezone resolution (start/end returned as raw strings). That's fine
 * for activity logging where the agent renders the times.
 */

export interface ICalEvent {
  uid: string
  summary: string
  description: string
  start: string
  end: string
  organizer: string | null
  attendees: string[]
}

function unfold(text: string): string[] {
  const out: string[] = []
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += line.slice(1)
    } else {
      out.push(line)
    }
  }
  return out
}

function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = line.indexOf(':')
  if (colon <= 0) return null
  const lhs = line.slice(0, colon)
  const value = line.slice(colon + 1)
  const parts = lhs.split(';')
  const name = parts[0]!.toUpperCase()
  const params: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const [k, v] = p.split('=')
    if (k && v) params[k.toUpperCase()] = v
  }
  return { name, params, value }
}

function unescape(v: string): string {
  return v.replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

function emailFromValue(v: string): string {
  // ATTENDEE values come in as `mailto:foo@bar.com` (case-insensitive)
  return v.replace(/^mailto:/i, '').trim()
}

export function parseIcs(text: string): ICalEvent[] {
  const lines = unfold(text)
  const events: ICalEvent[] = []
  let cur: Partial<ICalEvent> | null = null

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { attendees: [] }
      continue
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.uid && cur.start) {
        events.push({
          uid: cur.uid,
          summary: cur.summary ?? '',
          description: cur.description ?? '',
          start: cur.start,
          end: cur.end ?? cur.start,
          organizer: cur.organizer ?? null,
          attendees: cur.attendees ?? [],
        })
      }
      cur = null
      continue
    }
    if (!cur) continue
    const parsed = parseLine(line)
    if (!parsed) continue
    switch (parsed.name) {
      case 'UID':
        cur.uid = parsed.value
        break
      case 'SUMMARY':
        cur.summary = unescape(parsed.value)
        break
      case 'DESCRIPTION':
        cur.description = unescape(parsed.value)
        break
      case 'DTSTART':
        cur.start = parsed.value
        break
      case 'DTEND':
        cur.end = parsed.value
        break
      case 'ORGANIZER':
        cur.organizer = emailFromValue(parsed.value)
        break
      case 'ATTENDEE': {
        const email = emailFromValue(parsed.value)
        if (email) cur.attendees!.push(email)
        break
      }
    }
  }
  return events
}
