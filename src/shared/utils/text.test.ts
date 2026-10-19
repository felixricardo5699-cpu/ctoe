import { describe, expect, it } from 'vitest'
import { isBlank, normalizeText, stripCodeFences, stripWrappingQuotes } from './text'

const FENCE = String.fromCharCode(96).repeat(3)

describe('text utils', () => {
  it('normalizes CRLF and trims only the outside', () => {
    expect(normalizeText('  a\r\nb  ')).toBe('a\nb')
    expect(normalizeText('中文')).toBe('中文')
  })

  it('detects blank input', () => {
    expect(isBlank('   \n\t ')).toBe(true)
    expect(isBlank('hi')).toBe(false)
  })

  it('strips only a full wrapping quote pair', () => {
    expect(stripWrappingQuotes('"hello"')).toBe('hello')
    expect(stripWrappingQuotes('say "hi" to me')).toBe('say "hi" to me')
    expect(stripWrappingQuotes('"')).toBe('"')
    const open = String.fromCharCode(8220)
    const close = String.fromCharCode(8221)
    expect(stripWrappingQuotes(open + 'hi' + close)).toBe('hi')
  })

  it('unwraps a whole fenced block, with or without a language tag', () => {
    expect(stripCodeFences(FENCE + '\n自然英文表达：hola\n' + FENCE)).toBe('自然英文表达：hola')
    expect(stripCodeFences(FENCE + 'text\nline one\nline two\n' + FENCE)).toBe('line one\nline two')
  })

  it('leaves prose and half-open fences alone', () => {
    expect(stripCodeFences('no fence here')).toBe('no fence here')
    expect(stripCodeFences(FENCE + '\nunterminated')).toBe(FENCE + '\nunterminated')
    expect(stripCodeFences(FENCE)).toBe(FENCE)
    expect(stripCodeFences(FENCE + 'one line' + FENCE)).toBe(FENCE + 'one line' + FENCE)
  })

  it('keeps a fence that is part of the text', () => {
    const value = 'use a fence like ' + FENCE + 'code' + FENCE + ' around it'
    expect(stripCodeFences(value)).toBe(value)
  })
})
