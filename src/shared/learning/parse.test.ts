import { describe, expect, it } from 'vitest'
import {
  KNOWLEDGE_FIELD_LIMITS,
  KNOWLEDGE_POINT_SAFETY_LIMIT,
  type LearningItem
} from '../types'
import {
  MAX_ANALYSIS_CHARS,
  MAX_MEANING_CHARS,
  parseLearningAnalysis,
  parseLearningAnalysisPartial,
  parseUnderstanding,
  readStreamedMeaning
} from './parse'

const FENCE = String.fromCharCode(96).repeat(3)

function item(overrides: Partial<LearningItem> = {}): LearningItem {
  return {
    kind: 'expression',
    expression: 'something came up',
    meaning: '临时有事',
    why: '口语里常用来解释临时原因',
    example: 'Something came up, so I cannot make it tonight.',
    exampleTranslation: '临时有事，所以今晚我来不了。',
    ...overrides
  }
}

function wrap(items: unknown[]): string {
  return JSON.stringify({ items })
}

describe('parseLearningAnalysis', () => {
  it('reads the JSON shape the prompt asks for', () => {
    const analysis = parseLearningAnalysis(wrap([item()]))
    expect(analysis?.items).toEqual([item()])
  })

  it('does not care about a fence or chatty prose around the JSON', () => {
    expect(parseLearningAnalysis(FENCE + 'json\n' + wrap([item()]) + '\n' + FENCE)?.items).toHaveLength(1)
    expect(parseLearningAnalysis('Sure!\n' + wrap([item()]) + '\nHope this helps.')?.items).toHaveLength(1)
  })

  it('keeps every point the sentence deserves, and drops repeats', () => {
    const many = [
      item({ expression: 'one' }),
      item({ expression: 'two' }),
      item({ expression: 'three' }),
      item({ expression: 'four' }),
      item({ expression: 'ONE' })
    ]
    const analysis = parseLearningAnalysis(wrap(many))
    // No product cap of three any more: a rich sentence keeps all of its points, and a repeat
    // of a point already there is not a second point.
    expect(analysis?.items.map((entry) => entry.expression)).toEqual([
      'one',
      'two',
      'three',
      'four'
    ])
  })

  it('treats the same words under two kinds as two points', () => {
    const analysis = parseLearningAnalysis(
      wrap([
        item({ kind: 'expression', expression: 'figure out' }),
        item({ kind: 'vocabulary', expression: 'Figure  Out' })
      ])
    )
    expect(analysis?.items.map((entry) => entry.kind)).toEqual(['expression', 'vocabulary'])
  })

  it('holds only a safety limit, far above what a lesson ever reaches', () => {
    const flood = Array.from({ length: KNOWLEDGE_POINT_SAFETY_LIMIT + 5 }, (_, index) =>
      item({ expression: 'chunk ' + String(index) })
    )
    expect(parseLearningAnalysis(wrap(flood))?.items).toHaveLength(KNOWLEDGE_POINT_SAFETY_LIMIT)
    expect(KNOWLEDGE_POINT_SAFETY_LIMIT).toBeGreaterThan(3)
  })

  it('cuts an over-long field to its ceiling instead of dropping the point', () => {
    const analysis = parseLearningAnalysis(
      wrap([
        item({
          meaning: 'x'.repeat(KNOWLEDGE_FIELD_LIMITS.meaning + 40),
          why: 'y'.repeat(KNOWLEDGE_FIELD_LIMITS.why + 40),
          example: 'z'.repeat(KNOWLEDGE_FIELD_LIMITS.example + 40),
          exampleTranslation: 'w'.repeat(KNOWLEDGE_FIELD_LIMITS.exampleTranslation + 40)
        })
      ])
    )
    const point = analysis?.items[0]
    expect(point?.expression).toBe('something came up')
    expect(point?.meaning).toHaveLength(KNOWLEDGE_FIELD_LIMITS.meaning)
    expect(point?.why).toHaveLength(KNOWLEDGE_FIELD_LIMITS.why)
    expect(point?.example).toHaveLength(KNOWLEDGE_FIELD_LIMITS.example)
    expect(point?.exampleTranslation).toHaveLength(KNOWLEDGE_FIELD_LIMITS.exampleTranslation)
  })

  it('stops growing the note once it has spent its total size budget', () => {
    const huge = Array.from({ length: KNOWLEDGE_POINT_SAFETY_LIMIT }, (_, index) =>
      item({
        expression: 'chunk ' + String(index).padStart(3, '0'),
        meaning: 'm'.repeat(KNOWLEDGE_FIELD_LIMITS.meaning),
        why: 'w'.repeat(KNOWLEDGE_FIELD_LIMITS.why),
        example: 'e'.repeat(KNOWLEDGE_FIELD_LIMITS.example),
        exampleTranslation: 't'.repeat(KNOWLEDGE_FIELD_LIMITS.exampleTranslation)
      })
    )
    const kept = parseLearningAnalysis(wrap(huge))?.items ?? []
    // The point that crossed the budget is still kept; nothing after it is added.
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(KNOWLEDGE_POINT_SAFETY_LIMIT)
    const chars = kept.reduce((total, point) => total + point.meaning.length + point.why.length, 0)
    expect(chars).toBeLessThan(
      MAX_ANALYSIS_CHARS + KNOWLEDGE_FIELD_LIMITS.meaning + KNOWLEDGE_FIELD_LIMITS.why
    )
  })

  it('reads the importance hint, and leaves it off when it is missing or unreadable', () => {
    const analysis = parseLearningAnalysis(
      wrap([
        item({ expression: 'high one', importance: 'high' }),
        item({ expression: 'low one', importance: 'low' }),
        { kind: 'expression', expression: 'odd one', meaning: '有个含义', importance: 'urgent' }
      ])
    )
    expect(analysis?.items[0]?.importance).toBe('high')
    // A point called low is still the user's point: it is kept, never dropped for its rank.
    expect(analysis?.items[1]?.importance).toBe('low')
    expect(analysis?.items[2]?.importance).toBeUndefined()
  })

  it('drops entries that are missing the English chunk or its meaning', () => {
    const analysis = parseLearningAnalysis(
      wrap([
        { kind: 'expression', expression: '  ', meaning: '有含义但没原文' },
        { kind: 'expression', expression: 'no meaning' },
        item({ expression: 'kept' }),
        'not an object'
      ])
    )
    expect(analysis?.items.map((entry) => entry.expression)).toEqual(['kept'])
  })

  it('falls back to the generic kind and to empty optional rows', () => {
    const analysis = parseLearningAnalysis(wrap([{ kind: 'nonsense', expression: 'x', meaning: 'y' }]))
    expect(analysis?.items[0]).toEqual({
      kind: 'expression',
      expression: 'x',
      meaning: 'y',
      why: '',
      example: '',
      // Missing from an answer written before the prompt asked for it: empty, not a crash.
      exampleTranslation: ''
    })
  })

  it('reads the example translation, so the pair survives the parser', () => {
    const analysis = parseLearningAnalysis(
      wrap([item({ exampleTranslation: '临时有事，所以今晚我来不了。' })])
    )
    expect(analysis?.items[0]?.exampleTranslation).toBe('临时有事，所以今晚我来不了。')
    // The same read while the answer is still arriving, so a streamed point is complete too.
    expect(
      parseLearningAnalysisPartial(JSON.stringify({ items: [item()] }))?.items[0]?.exampleTranslation
    ).toBe('临时有事，所以今晚我来不了。')
  })

  it('leaves the translation empty for an answer written before the field existed', () => {
    const older = parseLearningAnalysis(wrap([{ kind: 'expression', expression: 'x', meaning: 'y' }]))

    expect(older?.items[0]?.exampleTranslation).toBe('')
  })

  it('returns null when there is nothing usable', () => {
    expect(parseLearningAnalysis('totally not json')).toBeNull()
    expect(parseLearningAnalysis('')).toBeNull()
    expect(parseLearningAnalysis('{ broken json')).toBeNull()
    expect(parseLearningAnalysis(wrap([]))).toBeNull()
    expect(parseLearningAnalysis(JSON.stringify({ items: 'nope' }))).toBeNull()
    expect(parseLearningAnalysis(JSON.stringify(['expression', 'meaning']))).toBeNull()
  })
})

describe('parseLearningAnalysisPartial', () => {
  it('says nothing until the stream reaches the items array', () => {
    expect(parseLearningAnalysisPartial('')).toBeNull()
    expect(parseLearningAnalysisPartial('{"items": [')).toBeNull()
    expect(parseLearningAnalysisPartial('{"items": [{"expression": "half')).toBeNull()
    expect(parseLearningAnalysisPartial('translation coming right up')).toBeNull()
  })

  it('returns the points that have already closed', () => {
    const json = JSON.stringify({ items: [item({ expression: 'one' }), item({ expression: 'two' })] })
    const oneDone = '{"items":[' + JSON.stringify(item({ expression: 'one' }))

    // One complete object is enough to start teaching, even with no closing bracket yet.
    expect(parseLearningAnalysisPartial(oneDone)?.items.map((entry) => entry.expression)).toEqual(['one'])
    // A point that is still being written is left out rather than guessed at.
    const truncated = json.slice(0, json.length - 12)
    expect(parseLearningAnalysisPartial(truncated)?.items.map((entry) => entry.expression)).toEqual(['one'])
    expect(parseLearningAnalysisPartial(json)?.items.map((entry) => entry.expression)).toEqual(['one', 'two'])
  })

  it('de-duplicates while streaming, and keeps every distinct point', () => {
    const many = ['one', 'two', 'three', 'four', 'ONE'].map((expression) => item({ expression }))
    const analysis = parseLearningAnalysisPartial(JSON.stringify({ items: many }))
    expect(analysis?.items.map((entry) => entry.expression)).toEqual([
      'one',
      'two',
      'three',
      'four'
    ])
  })

  it('ignores entries that are not objects', () => {
    expect(parseLearningAnalysisPartial('{"items":["nope"]}')).toBeNull()
    expect(parseLearningAnalysisPartial('{"items":[42, null]}')).toBeNull()
  })

  it('tolerates an opening code fence that has not been closed yet', () => {
    const fenced = FENCE + 'json' + String.fromCharCode(10) + '{"items":[' + JSON.stringify(item())
    expect(parseLearningAnalysisPartial(fenced)?.items).toHaveLength(1)
  })
})

describe('parseUnderstanding', () => {
  it('reads the meaning and the points out of one answer', () => {
    const answer = JSON.stringify({ meaning: '我本来打算加入你们，但临时有点事情。', items: [item()] })
    const understanding = parseUnderstanding(answer)
    expect(understanding?.meaning).toBe('我本来打算加入你们，但临时有点事情。')
    expect(understanding?.items).toEqual([item()])
  })

  it('keeps an answer that turned out to carry no points', () => {
    expect(parseUnderstanding('{"meaning":"就是打个招呼"}')).toEqual({ meaning: '就是打个招呼', items: [] })
  })

  it('is not an answer at all without a meaning', () => {
    expect(parseUnderstanding(JSON.stringify({ items: [item()] }))).toBeNull()
    expect(parseUnderstanding('{"meaning":"   "}')).toBeNull()
    expect(parseUnderstanding('nothing but prose')).toBeNull()
  })

  it('applies the same de-duplication, and the same point limits, as Learn', () => {
    const many = ['one', 'two', 'three', 'four', 'ONE'].map((expression) => item({ expression }))
    const understanding = parseUnderstanding(JSON.stringify({ meaning: '随便', items: many }))
    expect(understanding?.items.map((entry) => entry.expression)).toEqual([
      'one',
      'two',
      'three',
      'four'
    ])
  })

  it('carries the importance hint and the example translation through Understand too', () => {
    const understanding = parseUnderstanding(
      JSON.stringify({ meaning: '我本来打算加入你们。', items: [item({ importance: 'high' })] })
    )
    expect(understanding?.items[0]?.importance).toBe('high')
    expect(understanding?.items[0]?.exampleTranslation).toBe('临时有事，所以今晚我来不了。')
  })

  it('cuts a whole-sentence meaning to its own larger ceiling, not the label one', () => {
    const understanding = parseUnderstanding(
      JSON.stringify({ meaning: '很'.repeat(MAX_MEANING_CHARS + 25) })
    )
    expect(understanding?.meaning).toHaveLength(MAX_MEANING_CHARS)
  })

  it('sees through a code fence the model added anyway', () => {
    const fenced = FENCE + 'json' + String.fromCharCode(10) + '{"meaning":"临时有事","items":[]}' + String.fromCharCode(10) + FENCE
    expect(parseUnderstanding(fenced)?.meaning).toBe('临时有事')
  })
})

describe('readStreamedMeaning', () => {
  it('says nothing until the answer actually reaches the meaning', () => {
    expect(readStreamedMeaning('')).toBe('')
    expect(readStreamedMeaning('{"mea')).toBe('')
    expect(readStreamedMeaning('{"meaning"')).toBe('')
    expect(readStreamedMeaning('{"meaning":')).toBe('')
    expect(readStreamedMeaning('{"meaning":"')).toBe('')
  })

  it('grows with the stream, one character at a time', () => {
    const answer = '{"meaning":"临时有事","items":[]}'
    expect(readStreamedMeaning(answer.slice(0, 13))).toBe('临')
    expect(readStreamedMeaning(answer.slice(0, 14))).toBe('临时')
    expect(readStreamedMeaning(answer)).toBe('临时有事')
  })

  it('never shows half an escape sequence', () => {
    // Cut in the middle of a newline escape: no invented line break, then exactly one.
    expect(readStreamedMeaning('{"meaning":"line1\\')).toBe('line1')
    expect(readStreamedMeaning('{"meaning":"line1\\n')).toBe('line1\n')
    expect(readStreamedMeaning('{"meaning":"line1\\nline2')).toBe('line1\nline2')
  })

  it('reads unicode escapes the way JSON does', () => {
    expect(readStreamedMeaning('{"meaning":"\\u4f60\\u597d"}')).toBe('你好')
  })

  it('stops at an escape it does not recognise instead of guessing', () => {
    expect(readStreamedMeaning('{"meaning":"a\\xb"}')).toBe('a')
  })

  it('keeps the meaning once it has closed, while the points are still arriving', () => {
    expect(readStreamedMeaning('{"meaning":"临时有事","items":[{"kind":"expr')).toBe('临时有事')
  })

  it('never mistakes a point inside the items array for the meaning', () => {
    const itemsFirst =
      '{"items":[{"kind":"expression","expression":"x","meaning":"临时有事"}],"meaning":"整句的意思"}'
    expect(readStreamedMeaning(itemsFirst)).toBe('整句的意思')
  })

  it('says nothing when the object closed without a meaning', () => {
    expect(readStreamedMeaning('{"other":"x"}')).toBe('')
  })
})
