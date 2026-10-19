import { describe, expect, it } from 'vitest'
import {
  SseParser,
  extractDeltaText,
  extractMessageText,
  extractStreamError,
  parseJsonOrNull
} from './sse'

describe('SseParser', () => {
  it('holds back partial events until the block is complete', () => {
    const parser = new SseParser()
    expect(parser.push('data: {"a"')).toEqual([])
    expect(parser.push(':1}\n\ndata: [DONE]\n\n').map((event) => event.data)).toEqual(['{"a":1}', '[DONE]'])
  })

  it('accepts CRLF, comments and named events', () => {
    const parser = new SseParser()
    const events = parser.push(': keep-alive\r\nevent: message\r\ndata: hi\r\n\r\n')
    expect(events).toEqual([{ event: 'message', data: 'hi' }])
  })

  it('joins multi-line data payloads', () => {
    const parser = new SseParser()
    expect(parser.push('data: one\ndata: two\n\n').map((event) => event.data)).toEqual(['one\ntwo'])
  })

  it('ignores blocks without data and flushes a trailing event', () => {
    const parser = new SseParser()
    expect(parser.push(': nothing\n\n')).toEqual([])
    expect(parser.push('data: tail').map((event) => event.data)).toEqual([])
    expect(parser.flush().map((event) => event.data)).toEqual(['tail'])
  })
})

describe('payload extraction', () => {
  it('reads streaming deltas, including the legacy text field', () => {
    expect(extractDeltaText({ choices: [{ delta: { content: 'hi' } }] })).toBe('hi')
    expect(extractDeltaText({ choices: [{ text: 'hi' }] })).toBe('hi')
    expect(extractDeltaText({ choices: [] })).toBe('')
    expect(extractDeltaText(null)).toBe('')
    expect(extractDeltaText('nope')).toBe('')
  })

  it('reads non-streaming messages', () => {
    expect(extractMessageText({ choices: [{ message: { content: 'hi' } }] })).toBe('hi')
    expect(extractMessageText({ choices: [{ message: { content: 5 } }] })).toBe('')
  })

  it('surfaces errors that arrive inside a 200 stream', () => {
    expect(extractStreamError({ error: { message: 'boom' } })).toBe('boom')
    expect(extractStreamError({ error: 'boom' })).toBe('boom')
    expect(extractStreamError({ choices: [] })).toBe(null)
  })

  it('returns null instead of throwing on invalid json', () => {
    expect(parseJsonOrNull('not json')).toBe(null)
    expect(parseJsonOrNull('{"ok":true}')).toEqual({ ok: true })
  })
})
