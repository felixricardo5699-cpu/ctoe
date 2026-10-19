import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  LANGUAGES,
  LANGUAGE_CODES,
  SUPPORTED_LANGUAGES,
  findLanguage,
  isLanguageCode,
  speechTag,
  languageName,
  languageNativeName,
  resolveLanguageCode,
  textDirection,
  type LanguageCode
} from './registry'

describe('language registry', () => {
  it('covers the six UN official languages', () => {
    expect([...LANGUAGE_CODES].sort()).toEqual(['ar', 'en', 'es', 'fr', 'ru', 'zh'])
  })

  it('describes every language with a name, an endonym and a direction', () => {
    for (const language of LANGUAGES) {
      expect(language.name.length).toBeGreaterThan(0)
      expect(language.nativeName.length).toBeGreaterThan(0)
      expect(['ltr', 'rtl']).toContain(language.direction)
    }
  })

  it('gives each language a distinct code', () => {
    expect(new Set(LANGUAGE_CODES).size).toBe(LANGUAGE_CODES.length)
  })

  it('marks Arabic as right-to-left and nothing else', () => {
    expect(textDirection('ar')).toBe('rtl')
    for (const code of LANGUAGE_CODES.filter((entry) => entry !== 'ar')) {
      expect(textDirection(code)).toBe('ltr')
    }
  })

  it('gives every language a voice tag, because this is where languages live', () => {
    // Read-aloud needs a region ('fr-FR'), and a new language must not be able to slip in
    // without one: the speech layer reads the tag from here instead of keeping a second list.
    for (const language of LANGUAGES) expect(language.speechTag.length).toBeGreaterThan(0)
    expect(speechTag('ar')).toBe('ar-SA')
    expect(speechTag('de' as LanguageCode)).toBe('de')
  })

  it('lists the enabled languages as the ones the UI may offer', () => {
    expect(SUPPORTED_LANGUAGES.length).toBeGreaterThanOrEqual(6)
    expect(SUPPORTED_LANGUAGES.every((language) => language.enabled)).toBe(true)
  })

  it('accepts known codes and rejects everything else', () => {
    expect(isLanguageCode('fr')).toBe(true)
    expect(isLanguageCode('de')).toBe(false)
    expect(isLanguageCode('')).toBe(false)
    expect(isLanguageCode(undefined)).toBe(false)
    expect(isLanguageCode(42)).toBe(false)
  })

  it('resolves an unreadable value to the fallback instead of throwing', () => {
    expect(resolveLanguageCode('es', DEFAULT_NATIVE_LANGUAGE)).toBe('es')
    expect(resolveLanguageCode('klingon', DEFAULT_NATIVE_LANGUAGE)).toBe(DEFAULT_NATIVE_LANGUAGE)
    expect(resolveLanguageCode(null, DEFAULT_LEARNING_LANGUAGE)).toBe(DEFAULT_LEARNING_LANGUAGE)
  })

  it('names languages for prompts and pickers', () => {
    expect(languageName('zh')).toBe('Chinese')
    expect(languageNativeName('zh')).toBe('中文')
    expect(languageName('fr')).toBe('French')
    expect(languageNativeName('ar')).toBe('العربية')
    expect(findLanguage('ru')?.name).toBe('Russian')
    expect(findLanguage('de')).toBeNull()
  })

  it('falls back to the code itself when a language is unknown', () => {
    // The cast is the point of the test: a value from outside the registry must not throw.
    const unknown = 'de' as LanguageCode
    expect(languageName(unknown)).toBe('de')
    expect(languageNativeName(unknown)).toBe('de')
    expect(textDirection(unknown)).toBe('ltr')
  })

  it('defaults to a pair that actually exists', () => {
    expect(isLanguageCode(DEFAULT_NATIVE_LANGUAGE)).toBe(true)
    expect(isLanguageCode(DEFAULT_LEARNING_LANGUAGE)).toBe(true)
  })
})
