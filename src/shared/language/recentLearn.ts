import { nativeLanguageOf, sentenceMode } from './pair'
import type { LanguageCode } from './registry'
import { sameSentenceIdentity, type SentenceIdentity } from './records'
import { DEFAULT_TONE, type PanelMode, type RecentTranslation, type SavedSentence, type Tone } from '../types'

/*
 * What one recent row is, when it is looked at as a moment rather than as a translation.
 *
 * A row records a direction, not a relation: Say it comes to it as native -> learning, Understand
 * as learning -> native, and only the studied side tells those two apart. The row carries that
 * side (see RecentTranslation.learningLanguage), so a row can be learned even after the user has
 * moved on to another language - which is also why the relation is derived here, from the row,
 * and never read off the current settings.
 *
 * The one unreadable shape is a row written before that field existed. For those the profile is
 * the only evidence there is, so it is used when the row's own direction agrees with it, and the
 * row is reported as not learnable when it does not. Guessing there would mean coaching the wrong
 * language, which is the one thing Learn is never allowed to get wrong.
 */

/** Everything about a row that depends on knowing which side of it is being studied. */
export interface RecentMoment {
  /** The user's own language, read off the row. */
  nativeLanguage: LanguageCode
  /** The language being studied, read off the row. */
  learningLanguage: LanguageCode
  /** The register the moment was asked in, for the coaching request and for the record. */
  tone: Tone
  /** Which of the two things the user was doing, read off the direction. */
  mode: PanelMode
  /** What the user meant: the side in their own language, which Learn is asked about. */
  meaningText: string
  /** The sentence being studied: the side the note is written about. */
  studiedText: string
}

/** What the profile says, for rows that predate the field that would have said it themselves. */
export interface RecentFallback {
  nativeLanguage: LanguageCode
  learningLanguage: LanguageCode
}

/**
 * Reads one row as a moment, or returns null when it cannot be read at all: a row whose studied
 * side is unknown, that names the same language on both sides, or that is missing one of the two
 * texts (the coaching answer is written about one and from the other, so half a row is no use).
 */
export function recentMoment(
  row: RecentTranslation,
  fallback: RecentFallback
): RecentMoment | null {
  // Both sides the same language is not a translation at all, so there is nothing to learn.
  if (row.sourceLanguage === row.targetLanguage) return null
  const learningLanguage = studiedSideOf(row, fallback)
  if (learningLanguage === null) return null
  const nativeLanguage = nativeLanguageOf(
    {
      sourceLanguage: row.sourceLanguage,
      targetLanguage: row.targetLanguage,
      learningLanguage
    },
    fallback.nativeLanguage
  )
  if (nativeLanguage === learningLanguage) return null
  const mode = sentenceMode({
    sourceLanguage: row.sourceLanguage,
    targetLanguage: row.targetLanguage,
    learningLanguage
  })
  // Understand read the studied side in; Say it produced it. Either way the other side is what
  // the user meant, and both are needed: Learn is asked what it meant and about what it says.
  const studiedText = mode === 'understand' ? row.sourceText : row.targetText
  const meaningText = mode === 'understand' ? row.targetText : row.sourceText
  if (studiedText.trim().length === 0 || meaningText.trim().length === 0) return null
  return {
    nativeLanguage,
    learningLanguage,
    tone: row.tone ?? DEFAULT_TONE,
    mode,
    meaningText,
    studiedText
  }
}

/**
 * The side of the pair a row teaches. Its own word for it wins; without one, the profile is used
 * but only when the row's direction is one the profile could have produced.
 */
function studiedSideOf(row: RecentTranslation, fallback: RecentFallback): LanguageCode | null {
  if (row.learningLanguage !== undefined) return row.learningLanguage
  if (row.targetLanguage === fallback.learningLanguage) return row.targetLanguage
  if (row.sourceLanguage === fallback.learningLanguage) return row.sourceLanguage
  return null
}

/**
 * The identity the row would be filed under, for asking whether it is already in My Learning.
 * Built from the row and its moment, so it matches exactly what the store writes (see
 * sameSentenceIdentity) - the relation, the direction, and both texts as the user saw them.
 */
export function momentIdentity(
  row: RecentTranslation,
  moment: RecentMoment
): SentenceIdentity {
  return {
    nativeLanguage: moment.nativeLanguage,
    learningLanguage: moment.learningLanguage,
    sourceLanguage: row.sourceLanguage,
    targetLanguage: row.targetLanguage,
    originalText: row.sourceText,
    translatedText: row.targetText
  }
}

/** The sentence a row is already kept as, or null when it is not in the library yet. */
export function learnedFromRow(
  sentences: readonly SavedSentence[],
  row: RecentTranslation,
  moment: RecentMoment | null
): SavedSentence | null {
  if (moment === null) return null
  const identity = momentIdentity(row, moment)
  return sentences.find((sentence) => sameSentenceIdentity(sentence, identity)) ?? null
}
