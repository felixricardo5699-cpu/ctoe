import type { KnowledgePoint, LearningItem, LearningKind, SavedSentence } from '../types'
import { importanceOf, KNOWLEDGE_IMPORTANCE } from '../types'
import { pairKey, sentencePair } from './pair'
import type { LanguageCode } from './registry'
import { timeValue } from './time'

/*
 * Views over the saved sentences.
 *
 * The file on disk is the only source of truth, and it stores sentences - a point never travels
 * on its own. Everything the UI needs (the relation list, one relation's sentences, the
 * Expressions / Vocabulary views, search) is derived here, so no screen ever keeps its own copy of
 * what was saved or re-derives which side is being studied by itself.
 *
 * The subject of a view is the learning relation (native + learning), not the direction a moment
 * went in: Say it and Understand of the same relation are the same shelf of the same library, and
 * the direction is a property of each sentence inside it. See language/pair.ts for those helpers.
 */

/** One learning relation, with the sentences saved under it, newest first. */
export interface LanguagePairGroup {
  /** The user's own language. */
  nativeLanguage: LanguageCode
  /** The language being studied. */
  learningLanguage: LanguageCode
  /** How many sentences this relation holds, in both directions together. */
  count: number
  /** Saved time of the newest sentence, for ordering the relations themselves. */
  newestSavedAt: string
  sentences: SavedSentence[]
}

/** One knowledge point together with the sentence it belongs to. */
export interface SentencePoint {
  point: KnowledgePoint
  sentence: SavedSentence
}

/** The parts of a sentence that say which moment it is, as opposed to what it says. */
export type SentenceIdentity = Pick<
  SavedSentence,
  | 'nativeLanguage'
  | 'learningLanguage'
  | 'sourceLanguage'
  | 'targetLanguage'
  | 'originalText'
  | 'translatedText'
>

/** Whitespace and case are folded: retyping the same sentence must not create a second copy. */
function fold(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Whether two sentences are the same moment. Called by the store on save so pressing Save again
 * merges into the record that is already there instead of stacking a duplicate, and by the panel to
 * ask whether what is on screen is already kept.
 *
 * The relation is part of the identity: the same two lines kept by the same user while learning
 * something else is a different moment, and the panel must not call it already saved.
 */
export function sameSentenceIdentity(a: SentenceIdentity, b: SentenceIdentity): boolean {
  return (
    a.nativeLanguage === b.nativeLanguage &&
    a.learningLanguage === b.learningLanguage &&
    a.sourceLanguage === b.sourceLanguage &&
    a.targetLanguage === b.targetLanguage &&
    a.originalText.trim() === b.originalText.trim() &&
    a.translatedText.trim() === b.translatedText.trim()
  )
}

/** Newest saved first; ties fall back to the id so the order is never random. */
export function sortSentencesNewestFirst(sentences: readonly SavedSentence[]): SavedSentence[] {
  return [...sentences].sort((left, right) => {
    const delta = timeValue(right.savedAt) - timeValue(left.savedAt)
    return delta !== 0 ? delta : right.id - left.id
  })
}

/**
 * The My Learning landing list: one entry per learning relation, with the relation used most
 * recently first. A relation with nothing saved never appears.
 */
export function groupByLanguagePair(sentences: readonly SavedSentence[]): LanguagePairGroup[] {
  const groups = new Map<string, LanguagePairGroup>()
  for (const sentence of sortSentencesNewestFirst(sentences)) {
    const pair = sentencePair(sentence)
    const key = pairKey(pair)
    const existing = groups.get(key)
    if (existing === undefined) {
      groups.set(key, {
        nativeLanguage: pair.nativeLanguage,
        learningLanguage: pair.learningLanguage,
        count: 1,
        newestSavedAt: sentence.savedAt,
        sentences: [sentence]
      })
      continue
    }
    existing.count += 1
    existing.sentences.push(sentence)
  }
  return [...groups.entries()]
    .sort(([leftKey, left], [rightKey, right]) => {
      const delta = timeValue(right.newestSavedAt) - timeValue(left.newestSavedAt)
      return delta !== 0 ? delta : leftKey.localeCompare(rightKey)
    })
    .map(([, group]) => group)
}

/** One relation's sentences, newest first, whichever way each of them went. */
export function sentencesOfPair(
  sentences: readonly SavedSentence[],
  nativeLanguage: LanguageCode,
  learningLanguage: LanguageCode
): SavedSentence[] {
  return sortSentencesNewestFirst(
    sentences.filter(
      (sentence) =>
        sentence.nativeLanguage === nativeLanguage &&
        sentence.learningLanguage === learningLanguage
    )
  )
}

/**
 * The order a sentence's points are shown in: the model's ranking first (high, medium, low),
 * and within one rank the order the model returned them in. Sorting never drops anything -
 * a 'low' point is still shown, just further down.
 */
export function sortKnowledgePoints<T extends LearningItem>(points: readonly T[]): T[] {
  return [...points]
    .map((point, index) => ({ point, index }))
    .sort((left, right) => {
      const delta =
        KNOWLEDGE_IMPORTANCE.indexOf(importanceOf(left.point)) -
        KNOWLEDGE_IMPORTANCE.indexOf(importanceOf(right.point))
      return delta !== 0 ? delta : left.index - right.index
    })
    .map((entry) => entry.point)
}

/**
 * The derived Expressions / Vocabulary views: every point of one kind, carried by the sentence
 * it came from so the list can always name the moment. Newest sentence first.
 */
export function pointsOfKind(
  sentences: readonly SavedSentence[],
  kind: LearningKind
): SentencePoint[] {
  const lines: SentencePoint[] = []
  for (const sentence of sortSentencesNewestFirst(sentences)) {
    for (const point of sortKnowledgePoints(sentence.knowledgePoints)) {
      if (point.kind === kind) lines.push({ point, sentence })
    }
  }
  return lines
}

/** Everything one sentence can be found by. Kept here so search can never miss a field. */
function searchableFields(sentence: SavedSentence): string[] {
  const fields = [sentence.originalText, sentence.translatedText]
  for (const point of sentence.knowledgePoints) {
    fields.push(point.expression, point.meaning, point.why, point.example, point.exampleTranslation)
  }
  return fields
}

/**
 * Search over the whole library, across every relation. A hit on a knowledge point returns the
 * sentence that holds it - the point is never shown as a standalone result, which is the
 * difference between looking up a word and finding the moment you met it.
 */
export function searchSentences(
  sentences: readonly SavedSentence[],
  query: string
): SavedSentence[] {
  const needed = fold(query)
  if (needed.length === 0) return sortSentencesNewestFirst(sentences)
  return sortSentencesNewestFirst(
    sentences.filter((sentence) =>
      searchableFields(sentence).some((field) => fold(field).includes(needed))
    )
  )
}
