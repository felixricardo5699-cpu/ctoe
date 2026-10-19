/*
 * The learning relation, and how it differs from the direction of one sentence.
 *
 * Two languages are in play at all times, and they are not the same thing as "what went in and
 * what came out":
 *
 *   native  + learning          the relation, and the thing My Learning buckets and counts by
 *   source  -> target           the direction of *this* moment inside that relation
 *
 * Say it goes native -> learning, Understand walks the same relation back (learning -> native),
 * so one relation holds sentences in both directions. Keeping the two ideas apart is what makes
 * the sentence id count up once per relation instead of once per direction, and it is why
 * changing what the user is learning never rewrites what they already saved.
 */

import type { PanelMode, SavedSentence } from '../types'
import type { LanguageCode } from './registry'

/** The two languages of a learning relation: what the user speaks, and what they are learning. */
export interface LanguagePairKey {
  nativeLanguage: LanguageCode
  learningLanguage: LanguageCode
}

/** The halves of a sentence that name its relation. */
export type PairFields = Pick<SavedSentence, 'nativeLanguage' | 'learningLanguage'>

/** The halves of a sentence that name which way this particular moment went. */
export type DirectionFields = Pick<
  SavedSentence,
  'sourceLanguage' | 'targetLanguage' | 'learningLanguage'
>

/** Never appears in a language code, so two pairs can never fold into one key. */
const SEPARATOR = '\u0000'

/**
 * Identity of any two language codes in the order given, for maps and React keys. Used both for
 * a relation (native, learning) and for the direction a file happens to be filed under. Never
 * written to disk.
 */
export function languagePairKey(sourceLanguage: LanguageCode, targetLanguage: LanguageCode): string {
  return sourceLanguage + SEPARATOR + targetLanguage
}

/** Identity of a learning relation. Never written to disk. */
export function pairKey(pair: LanguagePairKey): string {
  return languagePairKey(pair.nativeLanguage, pair.learningLanguage)
}

/** The relation a saved sentence belongs to, read off the sentence itself. */
export function sentencePair(sentence: PairFields): LanguagePairKey {
  return {
    nativeLanguage: sentence.nativeLanguage,
    learningLanguage: sentence.learningLanguage
  }
}

export function isSamePair(left: LanguagePairKey, right: LanguagePairKey): boolean {
  return (
    left.nativeLanguage === right.nativeLanguage && left.learningLanguage === right.learningLanguage
  )
}

/**
 * The user's own language, read off a moment: the studied side is the learning language, so the
 * other side of the direction is what they speak. This is exact whenever the studied language is
 * one of the two sides, which is every sentence the app can produce - and it is the rule that
 * recovers the relation from files saved before the relation was written down.
 *
 * The one unreadable shape is a file that says all three sides are the same language. There is
 * nothing to read there, so the caller's own language stands in rather than a guess.
 */
export function nativeLanguageOf(fields: DirectionFields, fallback: LanguageCode): LanguageCode {
  const derived =
    fields.sourceLanguage === fields.learningLanguage
      ? fields.targetLanguage
      : fields.sourceLanguage
  return derived === fields.learningLanguage ? fallback : derived
}

/**
 * Whether two languages can be a learning relation at all.
 *
 * The same language on both sides is not one: there would be nothing to translate, nothing to
 * coach, and no second side to walk back to. Every layer that lets the two sides be chosen - the
 * pickers, the settings store - asks this before accepting them, so the rule is written once.
 */
export function isUsablePair(
  nativeLanguage: LanguageCode,
  learningLanguage: LanguageCode
): boolean {
  return nativeLanguage !== learningLanguage
}

/**
 * Whether a direction is one of the two this relation can go in. False for a relation with the
 * same language on both sides, which is not a pair at all.
 */
export function isValidDirection(
  pair: LanguagePairKey,
  sourceLanguage: LanguageCode,
  targetLanguage: LanguageCode
): boolean {
  if (!isUsablePair(pair.nativeLanguage, pair.learningLanguage)) return false
  const forward =
    sourceLanguage === pair.nativeLanguage && targetLanguage === pair.learningLanguage
  const back =
    sourceLanguage === pair.learningLanguage && targetLanguage === pair.nativeLanguage
  return forward || back
}

/**
 * Which of the two things the user was doing: reading the learned language ('understand'), or
 * producing it ('express'). Read off the direction rather than stored, because storing it would
 * be a second answer to the same question.
 */
export function sentenceMode(fields: DirectionFields): PanelMode {
  return fields.sourceLanguage === fields.learningLanguage ? 'understand' : 'express'
}

/**
 * The side of the sentence that is being studied: what Learn coaches and what is read aloud.
 */
export function studiedText(
  sentence: Pick<
    SavedSentence,
    'sourceLanguage' | 'originalText' | 'translatedText' | 'learningLanguage'
  >
): string {
  return sentence.sourceLanguage === sentence.learningLanguage
    ? sentence.originalText
    : sentence.translatedText
}
