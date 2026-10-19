/**
 * How long ago something happened, in words: '就在刚刚' / '12 分钟前' / '3 小时前' / '2 天前',
 * or the plain date once it is older than a month.
 *
 * The browser bridge's status line is the only caller, and it is answering one question: did the
 * extension ever actually reach this app? For that, '12 分钟前' is more useful than a timestamp.
 *
 * Two values render as the empty string rather than as a time, because both would otherwise be
 * read as a live connection: a stamp that cannot be parsed, and a stamp in the future (which is
 * what a clock that moved backwards produces). The caller decides what to say when it is empty.
 */
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const MONTH_DAYS = 30

export function relativeTimeLabel(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const elapsed = now - at
  if (elapsed < 0) return ''
  if (elapsed < MINUTE_MS) return '就在刚刚'
  if (elapsed < HOUR_MS) return String(Math.floor(elapsed / MINUTE_MS)) + ' 分钟前'
  if (elapsed < DAY_MS) return String(Math.floor(elapsed / HOUR_MS)) + ' 小时前'
  if (elapsed < MONTH_DAYS * DAY_MS) return String(Math.floor(elapsed / DAY_MS)) + ' 天前'
  return new Date(at).toLocaleDateString()
}
