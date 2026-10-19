import { describe, expect, it } from 'vitest'
import {
  LANGUAGE_PAIR_ID_EXHAUSTED,
  MAX_SENTENCE_ID,
  MIN_SENTENCE_ID,
  SentenceIdExhaustedError,
  SENTENCE_ID_DIGITS,
  assertCanAllocateSentenceId,
  canAllocateSentenceId,
  formatSentenceId,
  isSentenceId
} from './sentenceId'

describe('sentence id', () => {
  it('formats the ids My Learning shows', () => {
    expect(formatSentenceId(1)).toBe('#000001')
    expect(formatSentenceId(10)).toBe('#00000A')
    expect(formatSentenceId(255)).toBe('#0000FF')
    expect(formatSentenceId(0xa8f3)).toBe('#00A8F3')
    expect(formatSentenceId(MAX_SENTENCE_ID)).toBe('#FFFFFF')
  })

  it('pads every id to the same width', () => {
    for (const id of [1, 15, 16, 255, 256, 4095, 4096, MAX_SENTENCE_ID]) {
      const label = formatSentenceId(id)
      expect(label.length).toBe(SENTENCE_ID_DIGITS + 1)
      expect(label.startsWith('#')).toBe(true)
      expect(label.slice(1)).toBe(label.slice(1).toUpperCase())
    }
  })

  it('refuses values that are not ids', () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MIN_SENTENCE_ID - 1]) {
      expect(() => formatSentenceId(value)).toThrow(RangeError)
      expect(isSentenceId(value)).toBe(false)
      expect(canAllocateSentenceId(value)).toBe(false)
    }
    expect(() => formatSentenceId(undefined as unknown as number)).toThrow(RangeError)
  })

  it('never wraps around once the space is used up', () => {
    const onePastTheEnd = MAX_SENTENCE_ID + 1
    expect(() => formatSentenceId(onePastTheEnd)).toThrow(SentenceIdExhaustedError)
    expect(() => assertCanAllocateSentenceId(onePastTheEnd)).toThrow(SentenceIdExhaustedError)
    // The failure is an error, not a fresh '#000001'.
    expect(() => formatSentenceId(onePastTheEnd)).not.toThrow(RangeError)
    expect(canAllocateSentenceId(onePastTheEnd)).toBe(false)
  })

  it('reports exhaustion with a stable code', () => {
    try {
      formatSentenceId(MAX_SENTENCE_ID + 1)
      throw new Error('expected the formatter to refuse the id')
    } catch (error) {
      expect(error).toBeInstanceOf(SentenceIdExhaustedError)
      const exhausted = error as SentenceIdExhaustedError
      expect(exhausted.code).toBe(LANGUAGE_PAIR_ID_EXHAUSTED)
      expect(exhausted.name).toBe('SentenceIdExhaustedError')
    }
  })

  it('still allocates the last id of the space', () => {
    expect(canAllocateSentenceId(MAX_SENTENCE_ID)).toBe(true)
    expect(() => assertCanAllocateSentenceId(MAX_SENTENCE_ID)).not.toThrow()
    expect(canAllocateSentenceId(MIN_SENTENCE_ID)).toBe(true)
  })
})
