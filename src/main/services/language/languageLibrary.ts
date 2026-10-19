import { languagePairKey, nativeLanguageOf, type LanguagePairKey } from '@shared/language/pair'
import {
  DEFAULT_NATIVE_LANGUAGE,
  LANGUAGE_CODES,
  isLanguageCode,
  type LanguageCode
} from '@shared/language/registry'
import { MAX_SENTENCE_ID, MIN_SENTENCE_ID, SentenceIdExhaustedError } from '@shared/language/sentenceId'
import { timeValue } from '@shared/language/time'
import type { SavedSentence } from '@shared/types'

/*
 * The shape of learned.json in memory, and the one-way move from "filed by direction" to "filed
 * by relation".
 *
 * Older files were keyed by the direction of each moment - languages[source][target] - which split
 * one learning relation into two buckets with two id counters: Say it landed in zh -> en and
 * Understand in en -> zh, and both could hand out #000002. The current model keys a bucket by the
 * relation itself, languages[native][learning], so both directions share one counter.
 *
 * This module is the whole of that move: it reads nothing and writes nothing, so it can be run
 * over a file without any risk of half-migrating one on disk.
 */

/** One relation's sentences and its own id counter: what the file keeps per bucket. */
export interface LanguagePairFile {
  /** The next id this bucket will hand out. Read from the file, never derived, never reused. */
  nextId: number
  records: SavedSentence[]
}

/** The whole file: languages[nativeLanguage][learningLanguage]. */
export type LanguageLibrary = Record<string, Record<string, LanguagePairFile>>

/**
 * A sentence as an older file holds it. Every file written before the relation was recorded says
 * nothing about who the learner is, so the relation is read off the direction instead - see
 * relationOf. The current shape satisfies this one, which is why the move is safe to run over an
 * already-moved library.
 */
export interface StoredSentence extends Omit<SavedSentence, 'nativeLanguage'> {
  nativeLanguage?: LanguageCode
}

/** One bucket as the file holds it, keyed by whatever that version of the app filed it under. */
export interface StoredPairFile {
  nextId: number
  records: StoredSentence[]
}

export type StoredLibrary = Record<string, Record<string, StoredPairFile>>

export function emptyLibrary(): LanguageLibrary {
  return {}
}

export function emptyPair(): LanguagePairFile {
  return { nextId: MIN_SENTENCE_ID, records: [] }
}

/** The bucket's slot, created on first use. */
export function ensurePair(
  library: LanguageLibrary,
  nativeLanguage: LanguageCode,
  learningLanguage: LanguageCode
): LanguagePairFile {
  const byLearning = library[nativeLanguage] ?? {}
  library[nativeLanguage] = byLearning
  const pair = byLearning[learningLanguage] ?? emptyPair()
  byLearning[learningLanguage] = pair
  return pair
}

/** One bucket as an older file held it: everything filed under one direction. */
export interface DirectionBucket {
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  nextId: number
  records: StoredSentence[]
}

/** Every bucket a library holds, in a stable order, skipping the ones that never held anything. */
export function directionBucketsOf(library: StoredLibrary): DirectionBucket[] {
  const buckets: DirectionBucket[] = []
  for (const [sourceLanguage, byTarget] of Object.entries(library)) {
    if (!isLanguageCode(sourceLanguage)) continue
    for (const [targetLanguage, pair] of Object.entries(byTarget)) {
      if (!isLanguageCode(targetLanguage)) continue
      if (pair.records.length === 0 && pair.nextId === MIN_SENTENCE_ID) continue
      buckets.push({
        sourceLanguage,
        targetLanguage,
        nextId: pair.nextId,
        records: pair.records
      })
    }
  }
  return buckets.sort((left, right) => directionKey(left).localeCompare(directionKey(right)))
}

/** What the move did, so the caller can log it and the tests can pin it down. */
export interface PairMergeReport {
  /** How many direction buckets the file held. */
  directionsBefore: number
  /** How many relations those buckets collapse into. */
  pairsAfter: number
  /** Sentences that were filed under the wrong thing, i.e. that changed bucket. */
  movedSentences: number
  /**
   * Sentences whose relation was read off their direction, because the file did not state one -
   * which is every sentence in a file written before the relation was recorded.
   */
  derivedSentences: number
  /** Every id that had to change number, because two buckets had been counting separately. */
  remappedIds: ReadonlyArray<{ pairKey: string; from: number; to: number }>
}

export interface PairMergeResult {
  library: LanguageLibrary
  report: PairMergeReport
}

/**
 * Files every sentence under its learning relation, collapsing the direction buckets into one
 * bucket and one id sequence per relation.
 *
 * Ids are moved rather than renumbered: the first bucket of a relation keeps its numbers and every
 * later bucket is shifted past the numbers the earlier ones had already handed out. That is what
 * keeps the promise the id sequence makes - a number this pair ever used is never handed out again
 * - which a plain renumber from 1 would break the moment one of the two buckets had a deletion.
 * A bucket that holds nothing keeps its numbers reserved all the same, for both readings of its
 * direction, because nothing can tell which relation it would have belonged to.
 *
 * It also reads the relation off the direction for sentences whose file never stated one, because
 * every file written before the field existed says nothing about who the learner is.
 *
 * Running this over an already-merged library changes nothing: each relation is already one
 * bucket, so there is nothing to shift.
 *
 * What it does not do: rewrite the direction of a moment. The direction is what happened - which
 * side the user brought - and a file that says a moment went somewhere its relation does not go is
 * left saying so, rather than being given a direction nobody wrote.
 */
export function mergeDirectionsIntoPairs(library: StoredLibrary): PairMergeResult {
  const buckets = directionBucketsOf(library)
  const byKey = new Map<string, DirectionBucket>()
  const groups = new Map<string, PairGroup>()
  for (const bucket of buckets) byKey.set(directionKey(bucket), bucket)

  // Sentences first: a bucket that holds any is a contributor, and only a bucket that holds none
  // can be claimed by the two relations its direction could have belonged to.
  for (const bucket of buckets) {
    for (const sentence of bucket.records) {
      const pair = relationOf(sentence)
      const group = groupOf(groups, pair)
      const key = directionKey(bucket)
      group.contributors.set(key, bucket)
      group.entries.set(key, [...(group.entries.get(key) ?? []), sentence])
      if (key !== languagePairKey(pair.nativeLanguage, pair.learningLanguage)) group.moved += 1
      if (!statesRelation(sentence, pair)) group.derived += 1
    }
  }
  for (const bucket of buckets) {
    if (bucket.records.length > 0) continue
    for (const pair of candidatePairs(bucket)) {
      groupOf(groups, pair).spare.set(directionKey(bucket), bucket)
    }
  }

  const merged = emptyLibrary()
  const remappedIds: Array<{ pairKey: string; from: number; to: number }> = []
  let movedSentences = 0
  let derivedSentences = 0

  for (const group of groups.values()) {
    const ordered = orderedBuckets(group, byKey)
    let offset = 0
    const records: SavedSentence[] = []
    const key = pairKeyOf(group.pair)
    for (const bucket of ordered) {
      for (const sentence of group.entries.get(directionKey(bucket)) ?? []) {
        const id = sentence.id + offset
        if (id !== sentence.id) remappedIds.push({ pairKey: key, from: sentence.id, to: id })
        // The relation is written onto the sentence as well, so a sentence and the bucket it is
        // filed under can never disagree about who is learning what.
        records.push({
          ...sentence,
          id,
          nativeLanguage: group.pair.nativeLanguage,
          learningLanguage: group.pair.learningLanguage
        })
      }
      offset += bucketSize(bucket) - 1
    }
    const nextId = offset + 1
    // The numbers this relation has handed out no longer fit in six hex digits. Nothing is written
    // in that case: the caller keeps the file it already has instead of one with ids that cannot
    // be shown.
    if (nextId - 1 > MAX_SENTENCE_ID) throw new SentenceIdExhaustedError(nextId)
    const target = ensurePair(merged, group.pair.nativeLanguage, group.pair.learningLanguage)
    target.nextId = nextId
    target.records = sortByMoment(records)
    movedSentences += group.moved
    derivedSentences += group.derived
  }

  return {
    library: merged,
    report: {
      directionsBefore: buckets.length,
      pairsAfter: groups.size,
      movedSentences,
      derivedSentences,
      remappedIds
    }
  }
}

/** One relation being built, and the buckets feeding it. */
interface PairGroup {
  pair: LanguagePairKey
  contributors: Map<string, DirectionBucket>
  /** Counters with nothing in them, which this relation still has to keep reserved. */
  spare: Map<string, DirectionBucket>
  /** The sentences of this relation, grouped by the bucket they were filed under. */
  entries: Map<string, StoredSentence[]>
  moved: number
  derived: number
}

function groupOf(groups: Map<string, PairGroup>, pair: LanguagePairKey): PairGroup {
  const key = pairKeyOf(pair)
  const existing = groups.get(key)
  if (existing !== undefined) return existing
  const group: PairGroup = {
    pair,
    contributors: new Map(),
    spare: new Map(),
    entries: new Map(),
    moved: 0,
    derived: 0
  }
  groups.set(key, group)
  return group
}

function pairKeyOf(pair: LanguagePairKey): string {
  return languagePairKey(pair.nativeLanguage, pair.learningLanguage)
}

/** The key a bucket is filed under, which is a direction and not yet a relation. */
function directionKey(bucket: Pick<DirectionBucket, 'sourceLanguage' | 'targetLanguage'>): string {
  return languagePairKey(bucket.sourceLanguage, bucket.targetLanguage)
}

/**
 * The order a relation's buckets are laid out in: its own direction first, the other direction
 * second, and anything else that fed it afterwards. Sorting the leftovers keeps the result the same
 * whatever order the file happened to hold its buckets in.
 */
function orderedBuckets(
  group: PairGroup,
  byKey: Map<string, DirectionBucket>
): DirectionBucket[] {
  const ordered: DirectionBucket[] = []
  const taken = new Set<string>()
  const named = [
    pairKeyOf(group.pair),
    languagePairKey(group.pair.learningLanguage, group.pair.nativeLanguage)
  ]
  for (const key of named) {
    const bucket = byKey.get(key)
    if (bucket === undefined || taken.has(key)) continue
    // A bucket with sentences went to the relation those sentences belong to; only an empty one
    // can stand in for this relation as well.
    const isSpare = bucket.records.length === 0
    if (!isSpare && !group.contributors.has(key)) continue
    ordered.push(bucket)
    taken.add(key)
  }
  const rest = [...group.contributors.values(), ...group.spare.values()]
    .filter((bucket) => !taken.has(directionKey(bucket)))
    .sort((left, right) => directionKey(left).localeCompare(directionKey(right)))
  return [...ordered, ...rest]
}

/**
 * How many numbers a bucket has taken out of the space: what its counter says, and never less than
 * one past the highest id it actually holds, so a hand-edited counter cannot make the shift
 * overlap with a sentence that is in the file.
 */
function bucketSize(bucket: DirectionBucket): number {
  let highest = MIN_SENTENCE_ID - 1
  for (const sentence of bucket.records) highest = Math.max(highest, sentence.id)
  return Math.max(bucket.nextId, highest + 1)
}

/** The relations an empty bucket could have belonged to: its direction, read both ways. */
function candidatePairs(bucket: DirectionBucket): LanguagePairKey[] {
  return [
    { nativeLanguage: bucket.sourceLanguage, learningLanguage: bucket.targetLanguage },
    { nativeLanguage: bucket.targetLanguage, learningLanguage: bucket.sourceLanguage }
  ]
}

/**
 * The relation a sentence belongs to. The sentence says so itself now; a file written before the
 * field existed is read off the direction, which is exact because the studied side is always one
 * of the two. Only a sentence that claims all three sides are the same language has nothing left
 * to read - it is kept and given a relation that is at least not its own mirror, rather than being
 * dropped, and the original file stays on disk as a backup of what it really said.
 */
function relationOf(sentence: StoredSentence): LanguagePairKey {
  if (statesRelation(sentence, null)) {
    return {
      nativeLanguage: sentence.nativeLanguage as LanguageCode,
      learningLanguage: sentence.learningLanguage
    }
  }
  return {
    nativeLanguage: nativeLanguageOf(sentence, firstOtherLanguage(sentence.learningLanguage)),
    learningLanguage: sentence.learningLanguage
  }
}

/** Whether the sentence says who is learning what, and says something that is not its own mirror. */
function statesRelation(sentence: StoredSentence, pair: LanguagePairKey | null): boolean {
  const native = sentence.nativeLanguage
  if (!isLanguageCode(native) || native === sentence.learningLanguage) return false
  return pair === null || native === pair.nativeLanguage
}

/** Only reachable from a file that claims one language is all three sides; the registry has six. */
function firstOtherLanguage(learningLanguage: LanguageCode): LanguageCode {
  const found = LANGUAGE_CODES.find((code) => code !== learningLanguage)
  return found === undefined ? DEFAULT_NATIVE_LANGUAGE : found
}

/** The file reads in the order the moments happened, so a human can read it. */
function sortByMoment(records: readonly SavedSentence[]): SavedSentence[] {
  return [...records].sort((left, right) => {
    const delta = timeValue(left.savedAt) - timeValue(right.savedAt)
    return delta !== 0 ? delta : left.id - right.id
  })
}
