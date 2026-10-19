import { describe, expect, it } from 'vitest'
import type { LearningKind } from '../types'
import { expressionKey, knowledgePointKey } from './items'

function point(kind: LearningKind, expression: string): { kind: LearningKind; expression: string } {
  return { kind, expression }
}

describe('expressionKey', () => {
  it('folds case and spacing, so the same words are the same point', () => {
    expect(expressionKey('  Sign   Up For ')).toBe(expressionKey('sign up for'))
  })

  it('keeps different words apart', () => {
    expect(expressionKey('something came up')).not.toBe(expressionKey('came up'))
  })
})

describe('knowledgePointKey', () => {
  it('folds case and spacing inside the words', () => {
    expect(knowledgePointKey(point('expression', 'figure out'))).toBe(
      knowledgePointKey(point('expression', 'Figure  Out'))
    )
  })

  it('keeps the same words under different kinds apart', () => {
    // A vocabulary note and an expression note are two different notes to review, even when
    // the model used the same words for both.
    expect(knowledgePointKey(point('expression', 'sign up for'))).not.toBe(
      knowledgePointKey(point('vocabulary', 'sign up for'))
    )
  })

  it('keeps similar-but-different points apart', () => {
    expect(knowledgePointKey(point('expression', 'come up'))).not.toBe(
      knowledgePointKey(point('expression', 'come up with'))
    )
  })

  it('cannot be confused by a separator inside the words', () => {
    expect(knowledgePointKey(point('expression', 'a'))).not.toBe(
      knowledgePointKey(point('expression', 'a\u0000b'))
    )
  })
})
