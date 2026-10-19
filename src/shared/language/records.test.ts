import { describe, expect, it } from 'vitest'
import type { LanguageCode } from './registry'
import type {
  KnowledgeImportance,
  KnowledgePoint,
  LearningKind,
  SavedSentence,
  Tone
} from '../types'
import { nativeLanguageOf, sentencePair } from './pair'
import {
  groupByLanguagePair,
  pointsOfKind,
  sameSentenceIdentity,
  searchSentences,
  sentencesOfPair,
  sortKnowledgePoints,
  sortSentencesNewestFirst
} from './records'

function point(
  kind: LearningKind,
  expression: string,
  importance: KnowledgeImportance = 'medium',
  id = 'p-' + expression
): KnowledgePoint {
  return {
    id,
    kind,
    expression,
    meaning: '含义 ' + expression,
    why: '',
    example: 'Example with ' + expression,
    exampleTranslation: '例句 ' + expression,
    audioLanguage: 'en',
    importance
  }
}

/**
 * A sentence with sensible defaults; only the parts a test cares about are passed in.
 *
 * A sentence is studied on one side of its own direction, so the studied language defaults to the
 * side the text was turned into - the target - and the relation is then read off the direction,
 * exactly as the store reads it off a file.
 */
function sentence(over: Partial<SavedSentence> & { id: number }): SavedSentence {
  const merged = {
    sourceLanguage: 'zh' as LanguageCode,
    targetLanguage: 'en' as LanguageCode,
    originalText: '中文 ' + over.id,
    translatedText: 'English ' + over.id,
    tone: 'natural' as Tone,
    createdAt: '2026-09-24T10:00:00.000Z',
    savedAt: '2026-09-24T10:00:00.000Z',
    studyCount: 1,
    lastReviewedAt: '2026-09-24T10:00:00.000Z',
    masteryScore: 0,
    knowledgePoints: [] as KnowledgePoint[],
    ...over,
    learningLanguage: over.learningLanguage ?? over.targetLanguage ?? 'en'
  }
  return { ...merged, nativeLanguage: over.nativeLanguage ?? nativeLanguageOf(merged, 'zh') }
}

describe('sentencePair', () => {
  it('reads the relation off the sentence itself', () => {
    expect(sentencePair(sentence({ id: 1 }))).toEqual({
      nativeLanguage: 'zh',
      learningLanguage: 'en'
    })
  })

  it('reads one relation out of both of its directions', () => {
    // Say it produced the English half; Understand read it. Same learner, same shelf.
    const produced = sentence({ id: 1, nativeLanguage: 'en', learningLanguage: 'zh' })
    const read = sentence({
      id: 2,
      nativeLanguage: 'en',
      learningLanguage: 'zh',
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    })
    expect(sentencePair(produced)).toEqual(sentencePair(read))
  })
})

describe('sameSentenceIdentity', () => {
  it('treats the same pair and the same two lines as one moment', () => {
    const a = sentence({ id: 1, originalText: '我本来想去', translatedText: 'I was going to go.' })
    const b = sentence({ id: 7, savedAt: '2026-09-25T00:00:00.000Z', originalText: '我本来想去', translatedText: 'I was going to go.' })
    expect(sameSentenceIdentity(a, b)).toBe(true)
  })

  it('ignores surrounding whitespace, so a retyped sentence still matches', () => {
    const a = sentence({ id: 1, originalText: '我本来想去', translatedText: 'I was going to go.' })
    const b = sentence({
      id: 2,
      originalText: '  我本来想去  ',
      translatedText: '  I was going to go.  '
    })
    expect(sameSentenceIdentity(a, b)).toBe(true)
  })

  it('keeps a different relation apart even with the same words', () => {
    const zhEn = sentence({ id: 1, targetLanguage: 'en' })
    const zhFr = sentence({ id: 1, targetLanguage: 'fr' })
    expect(sameSentenceIdentity(zhEn, zhFr)).toBe(false)
  })

  it('keeps the two directions apart, because they are two different moments', () => {
    const produced = sentence({
      id: 1,
      nativeLanguage: 'en',
      learningLanguage: 'zh',
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      originalText: 'Same line',
      translatedText: '同样一句'
    })
    const read = sentence({
      id: 2,
      nativeLanguage: 'en',
      learningLanguage: 'zh',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      originalText: 'Same line',
      translatedText: '同样一句'
    })
    expect(sameSentenceIdentity(produced, read)).toBe(false)
  })

  it('keeps a changed line apart', () => {
    const a = sentence({ id: 1, translatedText: 'I was going to come.' })
    const b = sentence({ id: 1, translatedText: 'I was going to come, but something came up.' })
    expect(sameSentenceIdentity(a, b)).toBe(false)
  })
})

describe('sortSentencesNewestFirst', () => {
  it('puts the newest saved moment on top', () => {
    const sentences = [
      sentence({ id: 1, savedAt: '2026-09-24T10:00:00.000Z' }),
      sentence({ id: 2, savedAt: '2026-09-26T10:00:00.000Z' }),
      sentence({ id: 3, savedAt: '2026-09-25T10:00:00.000Z' })
    ]
    expect(sortSentencesNewestFirst(sentences).map((s) => s.id)).toEqual([2, 3, 1])
  })

  it('breaks a time tie with the id, so the order is never random', () => {
    const together = [
      sentence({ id: 4, savedAt: '2026-09-24T10:00:00.000Z' }),
      sentence({ id: 9, savedAt: '2026-09-24T10:00:00.000Z' })
    ]
    expect(sortSentencesNewestFirst(together).map((s) => s.id)).toEqual([9, 4])
  })

  it('sorts an unreadable time with the epoch instead of throwing', () => {
    const sentences = [
      sentence({ id: 1, savedAt: 'not a date' }),
      sentence({ id: 2, savedAt: '2026-09-24T10:00:00.000Z' })
    ]
    expect(sortSentencesNewestFirst(sentences).map((s) => s.id)).toEqual([2, 1])
  })

  it('leaves the input untouched', () => {
    const sentences = [
      sentence({ id: 1, savedAt: '2026-09-24T10:00:00.000Z' }),
      sentence({ id: 2, savedAt: '2026-09-26T10:00:00.000Z' })
    ]
    sortSentencesNewestFirst(sentences)
    expect(sentences.map((s) => s.id)).toEqual([1, 2])
  })
})

describe('groupByLanguagePair', () => {
  it('groups the sentences by the relation they were saved under', () => {
    const groups = groupByLanguagePair([
      sentence({ id: 1, targetLanguage: 'en' }),
      sentence({ id: 2, targetLanguage: 'en' }),
      sentence({ id: 3, targetLanguage: 'fr' })
    ])
    expect(groups.map((g) => [g.nativeLanguage, g.learningLanguage, g.count])).toEqual([
      ['zh', 'en', 2],
      ['zh', 'fr', 1]
    ])
  })

  it('files both directions of one relation on the same shelf', () => {
    // The whole point: Say it (en -> zh) and Understand (zh -> en) are one relation, one count,
    // and one id sequence - not two shelves that each hold half of the same learner's work.
    const groups = groupByLanguagePair([
      sentence({
        id: 1,
        nativeLanguage: 'en',
        learningLanguage: 'zh',
        sourceLanguage: 'en',
        targetLanguage: 'zh'
      }),
      sentence({
        id: 2,
        nativeLanguage: 'en',
        learningLanguage: 'zh',
        sourceLanguage: 'zh',
        targetLanguage: 'en'
      })
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].nativeLanguage).toBe('en')
    expect(groups[0].learningLanguage).toBe('zh')
    expect(groups[0].count).toBe(2)
    expect(groups[0].sentences.map((s) => s.id)).toEqual([2, 1])
  })

  it('orders the pairs by their newest sentence', () => {
    const groups = groupByLanguagePair([
      sentence({ id: 1, targetLanguage: 'en', savedAt: '2026-09-20T00:00:00.000Z' }),
      sentence({ id: 2, targetLanguage: 'fr', savedAt: '2026-09-26T00:00:00.000Z' })
    ])
    expect(groups.map((g) => g.learningLanguage)).toEqual(['fr', 'en'])
  })

  it('keeps each pair newest first', () => {
    const groups = groupByLanguagePair([
      sentence({ id: 1, targetLanguage: 'en', savedAt: '2026-09-20T00:00:00.000Z' }),
      sentence({ id: 2, targetLanguage: 'en', savedAt: '2026-09-26T00:00:00.000Z' }),
      sentence({ id: 3, targetLanguage: 'fr', savedAt: '2026-09-24T00:00:00.000Z' })
    ])
    expect(groups[0].sentences.map((s) => s.id)).toEqual([2, 1])
    expect(groups[0].count).toBe(2)
    expect(groups[0].newestSavedAt).toBe('2026-09-26T00:00:00.000Z')
  })

  it('never invents a pair with nothing saved', () => {
    expect(groupByLanguagePair([])).toEqual([])
  })
})

describe('sentencesOfPair', () => {
  it('returns only the asked-for relation, newest first', () => {
    const all = [
      sentence({ id: 1, targetLanguage: 'en', savedAt: '2026-09-20T00:00:00.000Z' }),
      sentence({ id: 2, targetLanguage: 'en', savedAt: '2026-09-26T00:00:00.000Z' }),
      sentence({ id: 3, targetLanguage: 'fr', savedAt: '2026-09-25T00:00:00.000Z' })
    ]
    expect(sentencesOfPair(all, 'zh', 'en').map((s) => s.id)).toEqual([2, 1])
    expect(sentencesOfPair(all, 'en', 'zh')).toEqual([])
  })

  it('reaches the same shelf from either direction of the relation', () => {
    // Understand is stored as zh -> en but belongs to the en -> zh learner's shelf.
    const all = [
      sentence({
        id: 1,
        nativeLanguage: 'en',
        learningLanguage: 'zh',
        sourceLanguage: 'en',
        targetLanguage: 'zh'
      }),
      sentence({
        id: 2,
        nativeLanguage: 'en',
        learningLanguage: 'zh',
        sourceLanguage: 'zh',
        targetLanguage: 'en'
      })
    ]
    expect(sentencesOfPair(all, 'en', 'zh').map((s) => s.id)).toEqual([2, 1])
  })
})

describe('sortKnowledgePoints', () => {
  it('shows the strongest points first', () => {
    const points = [
      point('vocabulary', 'tired', 'low'),
      point('expression', 'come up', 'high'),
      point('pattern', 'I was going to', 'medium')
    ]
    expect(sortKnowledgePoints(points).map((p) => p.expression)).toEqual([
      'come up',
      'I was going to',
      'tired'
    ])
  })

  it('never drops a low point - it only sorts last', () => {
    // 'low' is an ordering hint, not a verdict: the user asked to keep all of them.
    const points = [point('vocabulary', 'a', 'low'), point('vocabulary', 'b', 'low')]
    expect(sortKnowledgePoints(points)).toHaveLength(2)
  })

  it('reads a missing importance as medium and keeps the model order inside a rank', () => {
    // A file written before the field existed has no importance at all.
    const noHint = { ...point('expression', 'x'), importance: undefined } as unknown as KnowledgePoint
    const points = [point('expression', 'first'), noHint, point('expression', 'third')]
    expect(sortKnowledgePoints(points).map((p) => p.expression)).toEqual(['first', 'x', 'third'])
  })
})

describe('pointsOfKind', () => {
  it('collects one kind across sentences and carries the sentence along', () => {
    const sentences = [
      sentence({
        id: 2,
        savedAt: '2026-09-26T00:00:00.000Z',
        knowledgePoints: [point('expression', 'come up')]
      }),
      sentence({
        id: 1,
        savedAt: '2026-09-20T00:00:00.000Z',
        knowledgePoints: [point('expression', 'figure out'), point('vocabulary', 'tired')]
      })
    ]
    const lines = pointsOfKind(sentences, 'expression')
    expect(lines.map((l) => l.point.expression)).toEqual(['come up', 'figure out'])
    expect(lines.map((l) => l.sentence.id)).toEqual([2, 1])
    expect(pointsOfKind(sentences, 'grammar')).toEqual([])
  })
})

describe('searchSentences', () => {
  it('returns the whole sentence, never a lone point', () => {
    const moment = sentence({
      id: 1,
      originalText: '我完全没想到',
      translatedText: 'I had no idea they were all going to come together.',
      knowledgePoints: [point('expression', 'come together')]
    })
    const hits = searchSentences([moment], 'come together')
    expect(hits).toHaveLength(1)
    expect(hits[0].id).toBe(1)
    expect(hits[0].translatedText).toBe(moment.translatedText)
    expect(hits[0].knowledgePoints).toEqual(moment.knowledgePoints)
  })

  it('looks through every field of a sentence', () => {
    const moment = sentence({
      id: 1,
      originalText: '原文',
      translatedText: 'translated line',
      knowledgePoints: [
        {
          ...point('expression', 'expression text'),
          meaning: 'meaning text',
          why: 'why text',
          example: 'example text',
          exampleTranslation: 'example translation text'
        }
      ]
    })
    const queries = [
      '原文',
      'translated line',
      'expression text',
      'meaning text',
      'why text',
      'example text',
      'example translation text'
    ]
    for (const query of queries) {
      expect(searchSentences([moment], query).map((s) => s.id)).toEqual([1])
    }
  })

  it('folds whitespace and case', () => {
    const moment = sentence({ id: 1, translatedText: 'Come Together' })
    expect(searchSentences([moment], '  come   together ').map((s) => s.id)).toEqual([1])
  })

  it('returns everything, newest first, for an empty query', () => {
    const sentences = [
      sentence({ id: 1, savedAt: '2026-09-20T00:00:00.000Z' }),
      sentence({ id: 2, savedAt: '2026-09-26T00:00:00.000Z' })
    ]
    expect(searchSentences(sentences, '   ').map((s) => s.id)).toEqual([2, 1])
  })

  it('returns nothing when nothing matches', () => {
    expect(searchSentences([sentence({ id: 1 })], 'zzz')).toEqual([])
  })
})
