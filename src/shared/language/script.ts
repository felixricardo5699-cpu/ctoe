/*
 * Which writing system a piece of text is in.
 *
 * This exists for one job: a browser extension cannot always say which language a page is in - the
 * `lang` attribute is missing on a great many pages - so the bridge must be able to tell "this
 * sentence is in the language being learned" from "this sentence is in the user's own language"
 * without trusting the extension. The profile decides the direction; the script only decides
 * which side of that profile the text could have come from.
 *
 * It is deliberately about scripts and not about languages: 'latin' is English, French and Spanish
 * at once, so for a pair whose two sides share a script this says nothing and the caller keeps its
 * default. It only speaks when exactly one side of the profile could have written the text, which
 * is the case a page hint was supposed to cover and often does not.
 *
 * No dependencies, like the registry next to it: the main process, the renderer and any future
 * host can all read it.
 */

import type { LanguageCode } from './registry'

/** The writing systems the languages in the registry use. */
export type Script = 'han' | 'latin' | 'cyrillic' | 'arabic'

/**
 * Which script each language is written in.
 *
 * Typed as a total Record on purpose: adding a language to the registry without deciding its
 * script here is a compile error rather than a silent "this language is never recognised".
 */
export const SCRIPT_BY_LANGUAGE: Record<LanguageCode, Script> = {
  en: 'latin',
  zh: 'han',
  fr: 'latin',
  es: 'latin',
  ru: 'cyrillic',
  ar: 'arabic'
}

/**
 * The one script a text is written in, or null when the text does not say.
 *
 * Null is the answer for four different situations, and every one of them means the same thing to
 * a caller: nothing to learn from here. Empty or punctuation-only text has no letters at all; a
 * text whose letters belong to scripts this app does not teach (kana, hangul, greek...) is not in
 * a language the profile has an opinion about; and a text split evenly between two scripts is not
 * clearly either. Guessing in any of those cases is how a sentence gets coached in the wrong
 * language, which is worse than keeping the conservative default.
 */
export function dominantScript(text: string): Script | null {
  const counts: Record<Script, number> = { han: 0, latin: 0, cyrillic: 0, arabic: 0 }
  let other = 0
  for (const character of text) {
    const script = scriptOfCharacter(character)
    if (script === 'other') other += 1
    else if (script !== null) counts[script] += 1
  }
  let best: Script | null = null
  let bestCount = 0
  let tied = false
  for (const script of SCRIPTS) {
    if (counts[script] > bestCount) {
      best = script
      bestCount = counts[script]
      tied = false
    } else if (counts[script] === bestCount && bestCount > 0) {
      tied = true
    }
  }
  // A script this app cannot place holds as much of the text as the best one, so the text is not
  // in a language the profile has an opinion about - it only looks like it because of a few
  // borrowed words. The caller's default then stands.
  if (other >= bestCount) return null
  if (tied) return null
  return best
}

const SCRIPTS = ['han', 'latin', 'cyrillic', 'arabic'] as const

/**
 * The script one character is written in: a writing system, 'other' for a letter outside the ones
 * this app knows, or null for everything that is not a letter (spaces, digits, punctuation,
 * emoji, combining marks).
 *
 * The ranges cover the languages in the registry rather than Unicode in full. That is the point:
 * the answer this file gives is consumed by a six-language product, and a broader classification
 * would only invite it to answer about languages the profile cannot be in. The letter test comes
 * first so that the digits and punctuation that live inside those blocks - Arabic-Indic digits,
 * the Arabic comma, Cyrillic combining marks - are not counted as evidence of a language.
 */
function scriptOfCharacter(character: string): Script | 'other' | null {
  if (!LETTER.test(character)) return null
  const code = character.codePointAt(0) ?? 0
  if (isHan(code)) return 'han'
  if (isLatin(code)) return 'latin'
  if (isCyrillic(code)) return 'cyrillic'
  if (isArabic(code)) return 'arabic'
  // A letter that is none of the four: kana, hangul, greek, hebrew, devanagari, thai...
  return 'other'
}

/** CJK unified ideographs, their extensions, and the compatibility block. */
function isHan(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0x20000 && code <= 0x2fa1f)
  )
}

/** Basic Latin, Latin-1 Supplement letters, Latin Extended-A/B, Latin Extended Additional. */
function isLatin(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0xc0 && code <= 0x24f) ||
    (code >= 0x1e00 && code <= 0x1eff)
  )
}

function isCyrillic(code: number): boolean {
  return code >= 0x0400 && code <= 0x052f
}

/** Arabic, Arabic Supplement/Extended-A, and the two presentation-form blocks. */
function isArabic(code: number): boolean {
  return (
    (code >= 0x0600 && code <= 0x06ff) ||
    (code >= 0x0750 && code <= 0x077f) ||
    (code >= 0x08a0 && code <= 0x08ff) ||
    (code >= 0xfb50 && code <= 0xfdff) ||
    (code >= 0xfe70 && code <= 0xfeff)
  )
}

/** "Is this character a letter at all?" - the question that turns punctuation into nothing. */
const LETTER = /\p{L}/u
