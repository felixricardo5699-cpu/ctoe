import { languageName, textDirection, type LanguageCode, type TextDirection } from '../language/registry'
import type { TranslationRequest } from '../types'

/**
 * Which language is which, for one request.
 *
 * The direction is not fixed by the app: 'express' goes native -> learning, while
 * 'understand' walks the same pair the other way round. Both tasks therefore describe
 * themselves with the same three numbers, and no prompt has to know which pair it is
 * serving - which is what keeps Chinese -> English out of the source code.
 */
export interface LanguageContext {
  /** The language the user speaks: coaching text is always written in it. */
  native: LanguageCode
  /** The language being learned: the one being produced, or the one being read. */
  learning: LanguageCode
  /** English names, ready to drop straight into a prompt. */
  nativeName: string
  learningName: string
  /** Direction of the text the user brings in (what they type or paste). */
  sourceDirection: TextDirection
  /** Direction of the answer that comes back. */
  targetDirection: TextDirection
}

/**
 * Derives the pair from the request. The coaching answer (meaning, 'why it is worth
 * remembering') is always written in the user's own language, so it is the one language
 * the prompts never have to be told twice.
 */
export function languageContext(
  request: Pick<TranslationRequest, 'task' | 'sourceLanguage' | 'targetLanguage'>
): LanguageContext {
  const understanding = request.task === 'understand'
  // Reading someone else's text is the same pair read backwards: the source is the
  // language being learned, and the answer handed back is the user's own.
  const native = understanding ? request.targetLanguage : request.sourceLanguage
  const learning = understanding ? request.sourceLanguage : request.targetLanguage
  return {
    native,
    learning,
    nativeName: languageName(native),
    learningName: languageName(learning),
    sourceDirection: textDirection(request.sourceLanguage),
    targetDirection: textDirection(request.targetLanguage)
  }
}
