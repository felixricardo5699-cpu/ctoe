import { describe, expect, it } from 'vitest'
import { languagePairKey } from '@shared/language/pair'
import type { LanguageCode } from '@shared/language/registry'
import { LANGUAGE_PAIR_ID_EXHAUSTED, MAX_SENTENCE_ID } from '@shared/language/sentenceId'
import type { SavedSentence } from '@shared/types'
import {
  mergeDirectionsIntoPairs,
  type LanguageLibrary,
  type LanguagePairFile,
  type StoredLibrary,
  type StoredSentence
} from './languageLibrary'

/** A sentence as an older file holds it: what it is about, and nothing about who the learner is. */
function stored(over: Partial<StoredSentence> & { id: number }): StoredSentence {
  return {
    id: over.id,
    learningLanguage: over.learningLanguage ?? 'zh',
    sourceLanguage: over.sourceLanguage ?? 'en',
    targetLanguage: over.targetLanguage ?? 'zh',
    originalText: over.originalText ?? 'text ' + String(over.id),
    translatedText: over.translatedText ?? '译文 ' + String(over.id),
    tone: over.tone ?? 'natural',
    createdAt: over.createdAt ?? '2026-09-24T00:00:00.000Z',
    savedAt: over.savedAt ?? '2026-09-24T00:00:00.000Z',
    studyCount: over.studyCount ?? 1,
    lastReviewedAt: over.lastReviewedAt ?? '2026-09-24T00:00:00.000Z',
    masteryScore: over.masteryScore ?? 0,
    knowledgePoints: over.knowledgePoints ?? [],
    ...(over.nativeLanguage === undefined ? {} : { nativeLanguage: over.nativeLanguage })
  }
}

/** The same sentence as the current shape holds it, with the relation written down. */
function sentence(over: Partial<SavedSentence> & { id: number }): SavedSentence {
  return { ...stored(over), nativeLanguage: over.nativeLanguage ?? 'en' }
}

interface BucketSpec {
  source: LanguageCode
  target: LanguageCode
  nextId: number
  records: StoredSentence[]
}

function libraryOf(specs: readonly BucketSpec[]): StoredLibrary {
  const library: StoredLibrary = {}
  for (const spec of specs) {
    const byLearning = library[spec.source] ?? {}
    byLearning[spec.target] = { nextId: spec.nextId, records: spec.records }
    library[spec.source] = byLearning
  }
  return library
}

function pairOf(library: LanguageLibrary, native: string, learning: string): LanguagePairFile {
  const pair = library[native]?.[learning]
  if (pair === undefined) throw new Error('no bucket for ' + native + ' -> ' + learning)
  return pair
}

function ids(records: readonly SavedSentence[]): number[] {
  return records.map((record) => record.id)
}

/*
 * The real shape of a v5 file, taken off a machine that had been using the app: one learner
 * (native en, learning zh) whose saved moments ended up in two buckets, because Say it was filed
 * under the direction en -> zh and Understand under zh -> en. Both counted from 1, so both had
 * handed out a #000002 - which is why the two keys cannot stay separate. Neither sentence says who
 * the learner is, because that field did not exist when they were written.
 */
const realLibrary = libraryOf([
  {
    source: 'en',
    target: 'zh',
    nextId: 4,
    records: [
      stored({ id: 1, savedAt: '2026-09-23T15:41:39.301Z' }),
      stored({ id: 2, savedAt: '2026-09-23T17:14:21.597Z' }),
      stored({ id: 3, savedAt: '2026-09-24T02:25:16.198Z' })
    ]
  },
  {
    source: 'zh',
    target: 'en',
    nextId: 3,
    records: [stored({ id: 2, sourceLanguage: 'zh', targetLanguage: 'en', savedAt: '2026-09-24T02:26:07.004Z' })]
  }
])

describe('mergeDirectionsIntoPairs: reading the relation', () => {
  it('reads it off the direction when the file does not state one', () => {
    const { library, report } = mergeDirectionsIntoPairs(realLibrary)

    // Both directions are the same learner: en -> zh says so directly, zh -> en says it backwards.
    expect(Object.keys(library)).toEqual(['en'])
    expect(pairOf(library, 'en', 'zh').records.map((record) => record.nativeLanguage)).toEqual([
      'en',
      'en',
      'en',
      'en'
    ])
    expect(report.derivedSentences).toBe(4)
  })

  it('writes the relation onto every sentence it files', () => {
    const { library } = mergeDirectionsIntoPairs(realLibrary)

    const moved = pairOf(library, 'en', 'zh').records.find((record) => record.sourceLanguage === 'zh')
    // The direction is untouched - that is what happened - but the relation is now on the record,
    // so a sentence and the bucket it lives in can never disagree.
    expect(moved).toMatchObject({
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      nativeLanguage: 'en',
      learningLanguage: 'zh'
    })
  })

  it('keeps the relation the file states', () => {
    const stated = libraryOf([
      {
        source: 'es',
        target: 'fr',
        nextId: 2,
        records: [
          sentence({
            id: 1,
            nativeLanguage: 'fr',
            learningLanguage: 'es',
            sourceLanguage: 'es',
            targetLanguage: 'fr'
          })
        ]
      }
    ])

    const { library, report } = mergeDirectionsIntoPairs(stated)

    expect(pairOf(library, 'fr', 'es').records).toHaveLength(1)
    expect(report.derivedSentences).toBe(0)
  })

  it('ignores a stated relation that is the sentence own mirror, and keeps the sentence', () => {
    const broken = libraryOf([
      {
        source: 'zh',
        target: 'zh',
        nextId: 2,
        records: [
          sentence({
            id: 1,
            nativeLanguage: 'zh',
            learningLanguage: 'zh',
            sourceLanguage: 'zh',
            targetLanguage: 'zh'
          })
        ]
      }
    ])

    const { library, report } = mergeDirectionsIntoPairs(broken)

    expect(report.derivedSentences).toBe(1)
    const kept = pairOf(library, 'en', 'zh').records
    expect(kept).toHaveLength(1)
    // The studied side stays zh, and the other side is a real language rather than zh again.
    expect(kept[0]).toMatchObject({ learningLanguage: 'zh', nativeLanguage: 'en' })
  })
})

describe('mergeDirectionsIntoPairs: one relation, two directions', () => {
  it('files both directions under the one relation they belong to', () => {
    const { library, report } = mergeDirectionsIntoPairs(realLibrary)

    expect(Object.keys(library.en ?? {})).toEqual(['zh'])
    expect(pairOf(library, 'en', 'zh').records).toHaveLength(4)
    expect(report.directionsBefore).toBe(2)
    expect(report.pairsAfter).toBe(1)
    expect(report.movedSentences).toBe(1)
  })

  it('moves the ids of the second direction past the numbers the first had spent', () => {
    const { library, report } = mergeDirectionsIntoPairs(realLibrary)

    // en -> zh is this relation's own direction, so it goes first and keeps 1, 2, 3. The other
    // bucket had spent three numbers (1, 2 and a deleted 3), so its surviving #000002 becomes
    // #000005, and the relation carries on at #000006.
    expect(ids(pairOf(library, 'en', 'zh').records)).toEqual([1, 2, 3, 5])
    expect(pairOf(library, 'en', 'zh').nextId).toBe(6)
    expect(report.remappedIds).toEqual([{ pairKey: languagePairKey('en', 'zh'), from: 2, to: 5 }])
  })

  it('leaves no two sentences sharing a number', () => {
    const { library } = mergeDirectionsIntoPairs(realLibrary)
    const records = pairOf(library, 'en', 'zh').records
    expect(new Set(ids(records)).size).toBe(records.length)
  })

  it('reserves every number either bucket had handed out', () => {
    const { library } = mergeDirectionsIntoPairs(realLibrary)

    // 3 spent by en -> zh plus 2 spent by zh -> en: the relation owes its next number to both.
    expect(pairOf(library, 'en', 'zh').nextId - 1).toBe(4 - 1 + (3 - 1))
  })

  it('reads the file in the order the moments happened', () => {
    const { library } = mergeDirectionsIntoPairs(realLibrary)

    expect(pairOf(library, 'en', 'zh').records.map((record) => record.savedAt)).toEqual([
      '2026-09-23T15:41:39.301Z',
      '2026-09-23T17:14:21.597Z',
      '2026-09-24T02:25:16.198Z',
      '2026-09-24T02:26:07.004Z'
    ])
  })
})

describe('mergeDirectionsIntoPairs: what it must not change', () => {
  it('leaves a library that is already filed by relation exactly as it was', () => {
    const merged = mergeDirectionsIntoPairs(realLibrary).library
    const again = mergeDirectionsIntoPairs(merged)

    expect(again.library).toEqual(merged)
    expect(again.report).toMatchObject({
      directionsBefore: 1,
      pairsAfter: 1,
      movedSentences: 0,
      derivedSentences: 0,
      remappedIds: []
    })
  })

  it('keeps two relations apart, counters and all', () => {
    // The same user later learning English from Chinese: a second relation, with its own numbers.
    const twoRelations = libraryOf([
      { source: 'en', target: 'zh', nextId: 2, records: [stored({ id: 1 })] },
      {
        source: 'zh',
        target: 'en',
        nextId: 5,
        records: [
          sentence({
            id: 3,
            nativeLanguage: 'zh',
            learningLanguage: 'en',
            sourceLanguage: 'zh',
            targetLanguage: 'en'
          })
        ]
      }
    ])

    const { library } = mergeDirectionsIntoPairs(twoRelations)

    expect(pairOf(library, 'en', 'zh').nextId).toBe(2)
    expect(pairOf(library, 'en', 'zh').records[0]?.nativeLanguage).toBe('en')
    expect(pairOf(library, 'zh', 'en').nextId).toBe(5)
    expect(pairOf(library, 'zh', 'en').records[0]?.nativeLanguage).toBe('zh')
  })

  it('splits one direction bucket that held two relations', () => {
    // learningLanguage is stored per sentence, so a single direction can carry two relations.
    const mixed = libraryOf([
      {
        source: 'en',
        target: 'zh',
        nextId: 3,
        records: [
          stored({ id: 1 }),
          stored({ id: 2, learningLanguage: 'en', sourceLanguage: 'en', targetLanguage: 'zh' })
        ]
      }
    ])

    const { library, report } = mergeDirectionsIntoPairs(mixed)

    expect(report.pairsAfter).toBe(2)
    expect(ids(pairOf(library, 'en', 'zh').records)).toEqual([1])
    expect(ids(pairOf(library, 'zh', 'en').records)).toEqual([2])
  })

  it('keeps a counter that has nothing left in it reserved', () => {
    // Everything in the zh -> en direction was deleted, but those numbers are spent: the relation
    // must not start handing them out again.
    const emptied = libraryOf([
      { source: 'zh', target: 'en', nextId: 4, records: [] },
      { source: 'en', target: 'zh', nextId: 2, records: [stored({ id: 1 })] }
    ])

    const { library } = mergeDirectionsIntoPairs(emptied)

    expect(ids(pairOf(library, 'en', 'zh').records)).toEqual([1])
    expect(pairOf(library, 'en', 'zh').nextId).toBe(5)
  })

  it('counts an empty counter for both relations its direction could belong to', () => {
    // With no sentence in it, nothing says whether it was en -> zh or zh -> en, so neither relation
    // may reuse its numbers.
    const orphan = libraryOf([{ source: 'zh', target: 'en', nextId: 4, records: [] }])

    const { library, report } = mergeDirectionsIntoPairs(orphan)

    expect(report.pairsAfter).toBe(2)
    expect(pairOf(library, 'en', 'zh').nextId).toBe(4)
    expect(pairOf(library, 'zh', 'en').nextId).toBe(4)
  })

  it('drops a bucket that has never held anything', () => {
    const untouched = libraryOf([{ source: 'zh', target: 'en', nextId: 1, records: [] }])

    const { library, report } = mergeDirectionsIntoPairs(untouched)

    expect(library).toEqual({})
    expect(report.directionsBefore).toBe(0)
    expect(report.pairsAfter).toBe(0)
  })

  it('has nothing to do with an empty library', () => {
    expect(mergeDirectionsIntoPairs({})).toEqual({
      library: {},
      report: {
        directionsBefore: 0,
        pairsAfter: 0,
        movedSentences: 0,
        derivedSentences: 0,
        remappedIds: []
      }
    })
  })
})

describe('mergeDirectionsIntoPairs: running out of numbers', () => {
  it('refuses to move an id past the end of the space', () => {
    const crowded = libraryOf([
      { source: 'en', target: 'zh', nextId: MAX_SENTENCE_ID + 1, records: [stored({ id: 1 })] },
      { source: 'zh', target: 'en', nextId: 2, records: [stored({ id: 1, sourceLanguage: 'zh' })] }
    ])

    expect(() => mergeDirectionsIntoPairs(crowded)).toThrowError(LANGUAGE_PAIR_ID_EXHAUSTED)
  })

  it('accepts a relation that is already spent, as long as no id has to move past the end', () => {
    const spent = libraryOf([{ source: 'zh', target: 'en', nextId: MAX_SENTENCE_ID + 1, records: [] }])

    const { library } = mergeDirectionsIntoPairs(spent)

    expect(pairOf(library, 'en', 'zh').nextId).toBe(MAX_SENTENCE_ID + 1)
    expect(pairOf(library, 'zh', 'en').nextId).toBe(MAX_SENTENCE_ID + 1)
  })
})
