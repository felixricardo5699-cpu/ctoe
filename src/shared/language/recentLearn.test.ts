import { describe, expect, it } from 'vitest'
import type { RecentTranslation, SavedSentence } from '@shared/types'
import { learnedFromRow, momentIdentity, recentMoment } from './recentLearn'

const PROFILE = { nativeLanguage: 'zh', learningLanguage: 'en' } as const

/** One row as the store would have written it. */
function row(overrides: Partial<RecentTranslation> = {}): RecentTranslation {
  return {
    id: 'row-1',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    tone: 'casual',
    sourceText: '我本来想去，但是突然有事',
    targetText: 'I was going to go, but something came up.',
    createdAt: '2026-09-24T10:00:00.000Z',
    ...overrides
  }
}

describe('recentMoment: reading one row as a moment', () => {
  it('reads a Say it row: the answer is what is studied, the input is what was meant', () => {
    const moment = recentMoment(row(), PROFILE)

    expect(moment?.mode).toBe('express')
    expect(moment?.nativeLanguage).toBe('zh')
    expect(moment?.learningLanguage).toBe('en')
    expect(moment?.studiedText).toBe('I was going to go, but something came up.')
    expect(moment?.meaningText).toBe('我本来想去，但是突然有事')
    expect(moment?.tone).toBe('casual')
  })

  it('reads an Understand row: the studied side is the one that was read', () => {
    const moment = recentMoment(
      row({ sourceLanguage: 'en', targetLanguage: 'zh', sourceText: 'Something came up.', targetText: '临时有事。' }),
      PROFILE
    )

    expect(moment?.mode).toBe('understand')
    expect(moment?.nativeLanguage).toBe('zh')
    expect(moment?.learningLanguage).toBe('en')
    expect(moment?.studiedText).toBe('Something came up.')
    expect(moment?.meaningText).toBe('临时有事。')
  })

  it('files the relation the row names, not the one the settings name now', () => {
    // The user was learning English when they translated this, and studies French today. The row
    // still says which language it teaches, so it can still be learned - under its own relation.
    const moment = recentMoment(row(), { nativeLanguage: 'zh', learningLanguage: 'fr' })

    expect(moment?.learningLanguage).toBe('en')
    expect(moment?.nativeLanguage).toBe('zh')
  })

  it('falls back to the profile only for a row that does not say, and only when it agrees', () => {
    const legacy = row({ learningLanguage: undefined })
    expect(recentMoment(legacy, PROFILE)?.learningLanguage).toBe('en')
    // Understood the other way round, the profile still resolves it: the source is its pair's
    // other side, so this row must have been read rather than written.
    const legacyRead = row({ learningLanguage: undefined, sourceLanguage: 'en', targetLanguage: 'zh' })
    expect(recentMoment(legacyRead, PROFILE)?.mode).toBe('understand')
    // A row from a relation the profile no longer names cannot be placed at all: guessing here
    // would coach the wrong language.
    expect(recentMoment(legacy, { nativeLanguage: 'zh', learningLanguage: 'fr' })).toBeNull()
  })

  it('refuses half a row, because the coaching needs both sides', () => {
    expect(recentMoment(row({ sourceText: '   ' }), PROFILE)).toBeNull()
    expect(recentMoment(row({ targetText: '' }), PROFILE)).toBeNull()
  })

  it('refuses a row whose two sides are the same language', () => {
    expect(recentMoment(row({ sourceLanguage: 'en', targetLanguage: 'en' }), PROFILE)).toBeNull()
  })

  it('coaches a row with no register on record in the default one', () => {
    expect(recentMoment(row({ tone: undefined }), PROFILE)?.tone).toBe('natural')
  })
})

describe('recentMoment: matching the row against the library', () => {
  const moment = recentMoment(row(), PROFILE)

  function sentence(overrides: Partial<SavedSentence> = {}): SavedSentence {
    return {
      id: 1,
      nativeLanguage: 'zh',
      learningLanguage: 'en',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      originalText: '我本来想去，但是突然有事',
      translatedText: 'I was going to go, but something came up.',
      tone: 'casual',
      createdAt: '2026-09-24T10:00:00.000Z',
      savedAt: '2026-09-24T10:00:00.000Z',
      studyCount: 1,
      lastReviewedAt: '2026-09-24T10:00:00.000Z',
      masteryScore: 0,
      knowledgePoints: [],
      ...overrides
    }
  }

  it('names the identity the sentence would be filed under', () => {
    const identity = momentIdentity(row(), moment!)

    expect(identity).toEqual({
      nativeLanguage: 'zh',
      learningLanguage: 'en',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      originalText: '我本来想去，但是突然有事',
      translatedText: 'I was going to go, but something came up.'
    })
  })

  it('finds the sentence this row already is', () => {
    const kept = sentence()
    expect(learnedFromRow([kept], row(), moment)?.id).toBe(1)
  })

  it('does not call a sentence from another relation, or another wording, the same one', () => {
    // Same words, learned while studying French: a different moment, so not this row's.
    expect(learnedFromRow([sentence({ learningLanguage: 'fr', targetLanguage: 'fr' })], row(), moment)).toBeNull()
    expect(learnedFromRow([sentence({ translatedText: 'Another wording.' })], row(), moment)).toBeNull()
    expect(learnedFromRow([], row(), moment)).toBeNull()
  })

  it('says nothing when the row could not be read in the first place', () => {
    expect(learnedFromRow([sentence()], row(), null)).toBeNull()
  })
})
