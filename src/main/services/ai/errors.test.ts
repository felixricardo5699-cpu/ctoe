import { describe, expect, it } from 'vitest'
import { MAX_DETAIL_LENGTH, ProviderError, mapHttpStatus, redactKey, summarizeDetail } from './errors'

describe('mapHttpStatus', () => {
  it('maps the statuses users actually hit', () => {
    expect(mapHttpStatus(401, '')).toBe('unauthorized')
    expect(mapHttpStatus(403, '')).toBe('unauthorized')
    expect(mapHttpStatus(404, '')).toBe('model-not-found')
    expect(mapHttpStatus(429, '')).toBe('rate-limited')
    expect(mapHttpStatus(500, '')).toBe('server-error')
    expect(mapHttpStatus(503, '')).toBe('server-error')
  })

  it('treats a 400 mentioning a model as a bad model name', () => {
    expect(mapHttpStatus(400, 'Model Not Exist')).toBe('model-not-found')
    expect(mapHttpStatus(400, 'invalid payload')).toBe('malformed-response')
    expect(mapHttpStatus(418, 'teapot')).toBe('unknown')
  })
})

describe('summarizeDetail', () => {
  it('collapses whitespace and truncates so nothing huge reaches logs', () => {
    expect(summarizeDetail('a\n\nb   c')).toBe('a b c')
    expect(summarizeDetail('x'.repeat(400))).toHaveLength(MAX_DETAIL_LENGTH)
  })
})

describe('ProviderError', () => {
  it('carries the app-level code as its message', () => {
    const error = new ProviderError('unauthorized', 'HTTP 401')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('ProviderError')
    expect(error.message).toBe('unauthorized')
    expect(error.detail).toBe('HTTP 401')
  })
})

describe('redactKey', () => {
  it('scrubs a credential a provider echoed back', () => {
    const key = 'sk-secret-value'
    expect(redactKey('HTTP 401 {"message":"api key: ' + key + ' is invalid"}', key)).not.toContain(key)
    expect(redactKey('Bearer ' + key, key)).toBe('Bearer [redacted]')
  })

  it('leaves short values alone so real messages are not mangled', () => {
    expect(redactKey('HTTP 400 bad request', 'sk-1')).toBe('HTTP 400 bad request')
  })
})
