/** Trims the noise around pasted text (CRLF, outer blank lines) without touching meaning. */
export function normalizeText(value: string): string {
  return value.split('\r\n').join('\n').split('\r').join('\n').trim()
}

/**
 * Models sometimes wrap an answer in a fenced code block even when asked for plain prose.
 * Only the Learn note is run through this: the expression box must keep a fence the user
 * wrote on purpose.
 */
export function stripCodeFences(value: string): string {
  const trimmed = value.trim()
  const fence = String.fromCharCode(96).repeat(3)
  if (trimmed.length <= fence.length * 2) return trimmed
  if (!trimmed.startsWith(fence) || !trimmed.endsWith(fence)) return trimmed
  const inner = trimmed.slice(fence.length, trimmed.length - fence.length)
  const firstBreak = inner.indexOf('\n')
  // No line break after the opening fence means this was prose, not a real fence.
  if (firstBreak === -1) return trimmed
  return inner.slice(firstBreak + 1).trim()
}

export function isBlank(value: string): boolean {
  return value.trim().length === 0
}

/** Models sometimes wrap the whole answer in quotes; drop only such a wrapper. */
export function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    [String.fromCharCode(8220), String.fromCharCode(8221)]
  ]
  for (const [open, close] of pairs) {
    if (trimmed.length > 1 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, trimmed.length - close.length).trim()
    }
  }
  return trimmed
}
