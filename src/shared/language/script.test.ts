import { describe, expect, it } from 'vitest'
import { LANGUAGE_CODES } from './registry'
import { SCRIPT_BY_LANGUAGE, dominantScript } from './script'

describe('script: which writing system a text is in', () => {
  it('reads the six languages this app teaches', () => {
    expect(dominantScript('我觉得这个想法挺有意思，但是我不知道能不能成功。')).toBe('han')
    expect(dominantScript('I was going to join you, but something came up.')).toBe('latin')
    expect(dominantScript('Le musée ouvre ses portes à dix heures.')).toBe('latin')
    expect(dominantScript('Привет, как дела?')).toBe('cyrillic')
    expect(dominantScript('السلام عليكم، كيف حالك؟')).toBe('arabic')
  })

  it('ignores digits, punctuation and the spaces between words', () => {
    expect(dominantScript('2026-10-07 — 1,234!')).toBeNull()
    expect(dominantScript('   ')).toBeNull()
    expect(dominantScript('')).toBeNull()
    expect(dominantScript('###')).toBeNull()
  })

  it('answers with the script that carries the sentence, not the one that appears first', () => {
    // A borrowed English word in a Chinese sentence is not evidence that the sentence is English.
    expect(dominantScript('这个 API 真的很慢，我打算换一个。')).toBe('han')
    // ... and the other way round: two Chinese words quoted inside an English sentence.
    expect(dominantScript('She called it 麻烦 but it was really just paperwork.')).toBe('latin')
  })

  it('refuses to answer for a text split evenly between two scripts', () => {
    expect(dominantScript('ab 你好')).toBeNull()
    expect(dominantScript('аб 你好')).toBeNull()
    // Not a tie: more Cyrillic letters than Latin ones, so the sentence is readable as Russian.
    expect(dominantScript('Привет, hello')).toBe('cyrillic')
  })

  it('refuses to answer for a script this app does not teach', () => {
    // Japanese kana and Korean hangul are letters, but no language in the profile is written in
    // them - answering 'han' for a Japanese sentence would be exactly the guess this avoids.
    expect(dominantScript('これはテストです')).toBeNull()
    expect(dominantScript('안녕하세요')).toBeNull()
    // A Japanese sentence with kanji in it: the kana hold their own, so it is still not Chinese.
    expect(dominantScript('日本語のテストをします')).toBeNull()
  })
})

describe('script: the map from a language to its writing system', () => {
  it('names a script for every language the registry knows', () => {
    // The map is a total Record, so this is a compile-time guarantee as well; asserting it here
    // means a language added without a script fails the build *and* the test run.
    for (const code of LANGUAGE_CODES) {
      expect(['han', 'latin', 'cyrillic', 'arabic']).toContain(SCRIPT_BY_LANGUAGE[code])
    }
  })

  it('puts the three Latin-script languages in the same group, which is why a pair of them can never be told apart', () => {
    expect(SCRIPT_BY_LANGUAGE.en).toBe('latin')
    expect(SCRIPT_BY_LANGUAGE.fr).toBe('latin')
    expect(SCRIPT_BY_LANGUAGE.es).toBe('latin')
    expect(SCRIPT_BY_LANGUAGE.zh).toBe('han')
    expect(SCRIPT_BY_LANGUAGE.ru).toBe('cyrillic')
    expect(SCRIPT_BY_LANGUAGE.ar).toBe('arabic')
  })
})
