import { describe, expect, it } from 'vitest'
import { relativeTimeLabel } from './relativeTime'

const NOW = Date.parse('2026-09-24T12:00:00.000Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()

describe('relativeTimeLabel', () => {
  it('reads a fresh stamp as just now', () => {
    expect(relativeTimeLabel(ago(0), NOW)).toBe('就在刚刚')
    expect(relativeTimeLabel(ago(59_000), NOW)).toBe('就在刚刚')
  })

  it('counts up in minutes, then hours, then days', () => {
    expect(relativeTimeLabel(ago(60_000), NOW)).toBe('1 分钟前')
    expect(relativeTimeLabel(ago(12 * 60_000), NOW)).toBe('12 分钟前')
    expect(relativeTimeLabel(ago(59 * 60_000), NOW)).toBe('59 分钟前')
    expect(relativeTimeLabel(ago(60 * 60_000), NOW)).toBe('1 小时前')
    expect(relativeTimeLabel(ago(5 * 60 * 60_000), NOW)).toBe('5 小时前')
    expect(relativeTimeLabel(ago(23 * 60 * 60_000), NOW)).toBe('23 小时前')
    expect(relativeTimeLabel(ago(24 * 60 * 60_000), NOW)).toBe('1 天前')
    expect(relativeTimeLabel(ago(9 * 24 * 60 * 60_000), NOW)).toBe('9 天前')
  })

  it('falls back to a date once it is older than a month', () => {
    const label = relativeTimeLabel(ago(40 * 24 * 60 * 60_000), NOW)
    expect(label).not.toBe('')
    expect(label).toContain('2026')
  })

  it('refuses to call an unparseable stamp recent', () => {
    expect(relativeTimeLabel('', NOW)).toBe('')
    expect(relativeTimeLabel('not-a-date', NOW)).toBe('')
  })

  it('refuses a stamp from the future instead of rounding it to just now', () => {
    expect(relativeTimeLabel(new Date(NOW + 60_000).toISOString(), NOW)).toBe('')
  })

  it('defaults to the real clock when no time is given', () => {
    expect(relativeTimeLabel(new Date().toISOString())).toBe('就在刚刚')
  })
})
