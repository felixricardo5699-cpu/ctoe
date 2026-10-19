import { describe, expect, it } from 'vitest'
import {
  isSamePair,
  isUsablePair,
  languagePairKey,
  isValidDirection,
  nativeLanguageOf,
  pairKey,
  sentenceMode,
  sentencePair,
  studiedText
} from './pair'

const pair = { nativeLanguage: 'en', learningLanguage: 'zh' } as const

describe('pairKey', () => {
  it('separates the two halves so two relations cannot collide', () => {
    // 'en' + 'zh' must not read the same as 'e' + 'nzh'.
    expect(pairKey({ nativeLanguage: 'en', learningLanguage: 'zh' })).not.toBe('e' + 'nzh')
  })

  it('depends on which side is which', () => {
    // A Chinese speaker learning English is not an English speaker learning Chinese.
    expect(pairKey({ nativeLanguage: 'en', learningLanguage: 'zh' })).not.toBe(
      pairKey({ nativeLanguage: 'zh', learningLanguage: 'en' })
    )
  })
})

describe('languagePairKey', () => {
  it('is the same separator for a relation and for a direction, so the two can never fold', () => {
    expect(languagePairKey('en', 'zh')).toBe(pairKey({ nativeLanguage: 'en', learningLanguage: 'zh' }))
    expect(languagePairKey('en', 'zh')).not.toBe('e' + 'nzh')
  })
})

describe('sentencePair', () => {
  it('reads the relation off the sentence itself', () => {
    expect(sentencePair({ nativeLanguage: 'en', learningLanguage: 'zh' })).toEqual(pair)
  })
})

describe('isSamePair', () => {
  it('is true for the same two languages in the same roles', () => {
    expect(isSamePair(pair, { nativeLanguage: 'en', learningLanguage: 'zh' })).toBe(true)
  })

  it('is false when the roles are swapped, because that is another learner', () => {
    expect(isSamePair(pair, { nativeLanguage: 'zh', learningLanguage: 'en' })).toBe(false)
  })
})

describe('nativeLanguageOf', () => {
  it('reads the relation off a produced sentence: the source is the native side', () => {
    expect(
      nativeLanguageOf(
        { sourceLanguage: 'en', targetLanguage: 'zh', learningLanguage: 'zh' },
        'zh'
      )
    ).toBe('en')
  })

  it('reads the relation off a read sentence: the source is the studied side', () => {
    expect(
      nativeLanguageOf(
        { sourceLanguage: 'zh', targetLanguage: 'en', learningLanguage: 'zh' },
        'zh'
      )
    ).toBe('en')
  })

  it('reads a relation that is not the shipped pair', () => {
    expect(
      nativeLanguageOf(
        { sourceLanguage: 'fr', targetLanguage: 'es', learningLanguage: 'es' },
        'zh'
      )
    ).toBe('fr')
  })

  it('falls back when a file claims all three sides are the same language', () => {
    // Nothing can be read out of that shape, so the caller's own language stands in.
    expect(
      nativeLanguageOf(
        { sourceLanguage: 'zh', targetLanguage: 'zh', learningLanguage: 'zh' },
        'en'
      )
    ).toBe('en')
  })
})

describe('isUsablePair', () => {
  it('accepts two different languages, whichever order they are in', () => {
    expect(isUsablePair('zh', 'en')).toBe(true)
    expect(isUsablePair('en', 'zh')).toBe(true)
  })

  it('rejects a language paired with itself', () => {
    // Nothing to translate and nothing to learn, so no screen or store may accept this pair.
    expect(isUsablePair('fr', 'fr')).toBe(false)
  })
})

describe('isValidDirection', () => {
  it('accepts the relation walked forwards', () => {
    expect(isValidDirection(pair, 'en', 'zh')).toBe(true)
  })

  it('accepts the relation walked back, which is the other half of the same relation', () => {
    expect(isValidDirection(pair, 'zh', 'en')).toBe(true)
  })

  it('rejects a direction that leaves the relation', () => {
    expect(isValidDirection(pair, 'en', 'fr')).toBe(false)
    expect(isValidDirection(pair, 'fr', 'en')).toBe(false)
  })

  it('rejects a relation that is the same language on both sides', () => {
    expect(isValidDirection({ nativeLanguage: 'en', learningLanguage: 'en' }, 'en', 'en')).toBe(false)
  })
})

describe('sentenceMode', () => {
  it('is express when the user brought their own language', () => {
    expect(
      sentenceMode({ sourceLanguage: 'en', targetLanguage: 'zh', learningLanguage: 'zh' })
    ).toBe('express')
  })

  it('is understand when the user brought the language they are learning', () => {
    expect(
      sentenceMode({ sourceLanguage: 'zh', targetLanguage: 'en', learningLanguage: 'zh' })
    ).toBe('understand')
  })
})

describe('studiedText', () => {
  it('is what came back when the user produced the sentence', () => {
    expect(
      studiedText({
        sourceLanguage: 'en',
        learningLanguage: 'zh',
        originalText: 'That is not what I meant.',
        translatedText: '我不是那个意思。'
      })
    ).toBe('我不是那个意思。')
  })

  it('is what the user brought when they were reading it', () => {
    expect(
      studiedText({
        sourceLanguage: 'zh',
        learningLanguage: 'zh',
        originalText: '我本来打算加入你们。',
        translatedText: 'I was going to join you.'
      })
    ).toBe('我本来打算加入你们。')
  })
})
