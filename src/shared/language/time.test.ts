import { describe, expect, it } from 'vitest'
import { FALLBACK_TIME_ISO, nowIso, timeValue, toIsoTime } from './time'

describe('stored time', () => {
  it('keeps an ISO-8601 string exactly as it is', () => {
    expect(toIsoTime('2026-09-24T10:32:15.123Z')).toBe('2026-09-24T10:32:15.123Z')
  })

  it('reads the epoch milliseconds that older files used', () => {
    // v4 wrote numbers; v5 stores strings. The value must survive the conversion.
    expect(toIsoTime(0)).toBe('1970-01-01T00:00:00.000Z')
    expect(toIsoTime(1_724_174_535_123)).toBe(new Date(1_724_174_535_123).toISOString())
    expect(toIsoTime(1_724_174_535_123)).toBe(new Date(1_724_174_535_123).toISOString())
    expect(toIsoTime(1_700_000_000_000)).toBe('2023-11-14T22:13:20.000Z')
  })

  it('never turns an unreadable time into "now"', () => {
    // A corrupt field must not read as freshly saved, or the newest note would sort to the top.
    const garbage: unknown[] = [
      '',
      '   ',
      'not a date',
      'yesterday',
      {},
      [],
      null,
      undefined,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_VALUE
    ]
    for (const value of garbage) {
      expect(toIsoTime(value)).toBe(FALLBACK_TIME_ISO)
    }
  })

  it('reads the same bad value the same way every time', () => {
    expect(toIsoTime('nonsense')).toBe(toIsoTime('nonsense'))
  })

  it('uses the epoch as the sort key for an unreadable time', () => {
    expect(timeValue(FALLBACK_TIME_ISO)).toBe(0)
    expect(timeValue('not a date')).toBe(0)
    expect(timeValue('2026-09-24T10:32:15.123Z')).toBe(Date.parse('2026-09-24T10:32:15.123Z'))
  })

  it('orders by the time value, milliseconds included', () => {
    expect(timeValue('2026-09-24T10:32:15.123Z')).toBeLessThan(
      timeValue('2026-09-24T10:32:15.124Z')
    )
    expect(timeValue('2024-01-01T00:00:00.000Z')).toBeLessThan(
      timeValue('2026-01-01T00:00:00.000Z')
    )
  })

  it('stamps the current time in the stored format', () => {
    const stamp = nowIso()
    // Already the stored shape, and it survives a round trip through the reader.
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(toIsoTime(stamp)).toBe(stamp)
    expect(Number.isFinite(timeValue(stamp))).toBe(true)
  })
})
