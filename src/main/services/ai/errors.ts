import type { TranslationErrorCode } from '@shared/types'

/**
 * Every provider failure is normalized into an app-level error code; the UI turns
 * that code into a friendly sentence. `detail` is for developers/logs only and is
 * truncated by the caller so a raw API response can never be dumped at the user.
 */
export class ProviderError extends Error {
  readonly code: TranslationErrorCode
  readonly detail: string

  constructor(code: TranslationErrorCode, detail: string) {
    super(code)
    this.name = 'ProviderError'
    this.code = code
    this.detail = detail
  }
}

export const MAX_DETAIL_LENGTH = 300

/**
 * Some providers echo part of the credential back inside an error body. Every detail
 * string goes through this before it can reach a log, so a key can never leak out of a
 * failure path even if a provider is careless.
 */
export function redactKey(text: string, apiKey: string): string {
  const key = apiKey.trim()
  if (key.length < 8) return text
  return text.split(key).join('[redacted]')
}

/** Keeps developer detail short and single-line so it is safe to log. */
export function summarizeDetail(value: string): string {
  return value.split(/\s+/).join(' ').trim().slice(0, MAX_DETAIL_LENGTH)
}

export function mapHttpStatus(status: number, body: string): TranslationErrorCode {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'model-not-found'
  if (status === 429) return 'rate-limited'
  if (status >= 500) return 'server-error'
  // Providers disagree on how to report a bad model name (400 vs 404).
  if (status === 400 && body.toLowerCase().includes('model')) return 'model-not-found'
  if (status === 400) return 'malformed-response'
  return 'unknown'
}
