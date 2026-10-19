/*
 * Saved times, in the one format the file keeps: an ISO-8601 UTC string
 * ('2026-09-24T10:32:15.123Z').
 *
 * Two rules live here so no other module has to remember them: an unreadable time becomes the
 * epoch instead of "now" (a bad file must not silently look freshly saved), and comparisons go
 * through timeValue so string and number never get compared to each other.
 */

/** What an unreadable or missing time becomes. Deterministic: the same file always reads the same. */
export const FALLBACK_TIME_ISO = '1970-01-01T00:00:00.000Z'

/** The largest time Date can represent (ECMAScript: +/- 8.64e15 ms from the epoch). */
const MAX_TIME_MS = 8.64e15

function isUsableTime(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= MAX_TIME_MS
}

/** Now, in the stored format. */
export function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Reads a stored time: an ISO string, or the epoch-millisecond number older files used.
 * Anything unreadable falls back to the epoch rather than to the current time.
 */
export function toIsoTime(value: unknown): string {
  if (typeof value === 'number' && isUsableTime(value)) return new Date(value).toISOString()
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed) && isUsableTime(parsed)) return new Date(parsed).toISOString()
  }
  return FALLBACK_TIME_ISO
}

/** Sort key of a stored time; unreadable values sort with the epoch. */
export function timeValue(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}
