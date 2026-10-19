import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { knowledgePointKey } from '@shared/language/items'
import { nativeLanguageOf, type DirectionFields } from '@shared/language/pair'
import {
  emptyLibrary,
  ensurePair,
  mergeDirectionsIntoPairs,
  type LanguageLibrary,
  type LanguagePairFile,
  type PairMergeReport
} from './languageLibrary'
import { sameSentenceIdentity, sortSentencesNewestFirst } from '@shared/language/records'
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  isLanguageCode,
  resolveLanguageCode,
  type LanguageCode
} from '@shared/language/registry'
import {
  MAX_SENTENCE_ID,
  MIN_SENTENCE_ID,
  assertCanAllocateSentenceId,
  isSentenceId
} from '@shared/language/sentenceId'
import { FALLBACK_TIME_ISO, nowIso, timeValue, toIsoTime } from '@shared/language/time'
import {
  DEFAULT_KNOWLEDGE_IMPORTANCE,
  DEFAULT_MASTERY_SCORE,
  MASTERY_SCORE_MAX,
  isKnowledgeImportance,
  isLearningKind,
  isTone,
  type KnowledgePoint,
  type LearningItem,
  type LearningRecord,
  type SavedSentence,
  type SavedSentenceDraft,
  type SavedSentenceRef
} from '@shared/types'
import { backupFile, writeJsonAtomic } from '../storage/atomicJson'

/** The shape on disk. Bumped when the model changes; older files are upgraded on open. */
const LANGUAGE_VERSION = 7

/**
 * The version whose buckets are already keyed by relation, which is the shape the file has had
 * since then. A file written from it needs no restructuring: whatever fields were added since
 * read with their defaults, so opening the app touches nothing, and the file is brought up to
 * date - once, behind a backup - by the next write that actually has something to say.
 */
const RELATION_FILED_SINCE = 6

/**
 * The file kept its old name on purpose: sentences saved before this version are read out of
 * it and rewritten in the new shape, so nobody loses their notes on upgrade.
 */
const LANGUAGE_FILE_NAME = 'learned.json'

/**
 * Where the file is copied before a one-way upgrade rewrites it. Named after the version it came
 * from, so the v4 file and the v5 file each keep their own copy instead of one overwriting the
 * other, and a second open never touches a copy that is already there.
 */
function upgradeBackupPath(filePath: string, fromVersion: number | null): string {
  return filePath + (fromVersion === null ? '.legacy.bak' : '.v' + String(fromVersion) + '.bak')
}

/*
 * The file's shape, the helpers that hand out a bucket and the upgrade from "filed by direction" to
 * "filed by relation" all live in languageLibrary.ts. This store is the stateful part: it opens the
 * file, hands out ids from the relation's own counter, and writes the whole thing back atomically.
 */

/**
 * My Learning: every sentence the user chose to keep, in a plain JSON file next to config.json
 * in the app-data directory. No server, no account, no sync - this file is the whole feature.
 *
 * Three rules it never breaks: nothing is written unless the user asked to learn something, a
 * sentence is the unit that is stored (its points live inside it and never travel alone), and an
 * id that has been handed out is never handed out again - deleting a sentence leaves its number
 * spent.
 */
export class LanguageStore {
  private constructor(
    private readonly filePath: string,
    private languages: LanguageLibrary,
    /**
     * The version a file that only misses the newer fields was read from. The rewrite waits for
     * the next real write, so opening the app never rewrites what the user has.
     */
    private pendingFromVersion: number | null = null
  ) {}

  /**
   * Opens the file, upgrading an older one on the way - the only write the user did not ask for,
   * and one that goes through a backup plus an atomic replace, so a failure leaves the old file
   * exactly as it was.
   */
  static open(filePath: string = join(app.getPath('userData'), LANGUAGE_FILE_NAME)): LanguageStore {
    const { library, upgraded, fromVersion, pendingFromVersion } = readLanguageFile(filePath)
    const store = new LanguageStore(filePath, library, pendingFromVersion)
    if (upgraded) store.persistUpgrade(fromVersion)
    return store
  }

  get path(): string {
    return this.filePath
  }

  /** Every saved sentence, newest first: this is read as "what have I been learning lately". */
  list(): SavedSentence[] {
    return sortSentencesNewestFirst(this.allSentences())
  }

  /**
   * Saves one moment without counting it as study. Learn is the way in for the product, so this
   * is the plain write: the same identity, the same merging, but a sentence that was never
   * studied. Saving the same sentence twice refreshes it rather than stacking a second copy.
   */
  save(draft: SavedSentenceDraft): SavedSentence[] {
    this.write(draft, false)
    this.persist()
    return this.list()
  }

  /**
   * Learns one sentence: the write path Learn uses, and the one the product is moving to as the
   * only way in. It stores exactly what save() stores - the same identity, the same merging, the
   * same id - and adds the study bookkeeping, because asking for the analysis *is* the study act.
   *
   * Learning the same words again is a second pass over one record, never a second record: the id,
   * the createdAt and the points already kept all stay, and only the counters move.
   */
  learn(draft: SavedSentenceDraft): SavedSentence {
    const studied = this.write(draft, true)
    this.persist()
    // The record itself, not the whole shelf: this is the write Learn shows a receipt for.
    return studied
  }

  /**
   * The one place a sentence is created or refreshed. The relation is read off the moment itself:
   * the studied side is one of the two sides of the direction, so the other side is what the user
   * speaks. That makes the relation, and not the direction, the thing a sentence is filed and
   * numbered under - which is why Say it and Understand of one relation share a shelf and an id
   * sequence.
   */
  private write(draft: SavedSentenceDraft, studied: boolean): SavedSentence {
    const nativeLanguage = nativeLanguageOf(draft, DEFAULT_NATIVE_LANGUAGE)
    const pair = ensurePair(this.languages, nativeLanguage, draft.learningLanguage)
    const existing = pair.records.find((sentence) =>
      sameSentenceIdentity(sentence, { ...draft, nativeLanguage })
    )
    const now = nowIso()
    if (existing === undefined) {
      // The counter is checked before it is used: a relation that has handed out its last id says
      // so instead of wrapping around and overwriting #000001.
      const id = pair.nextId
      assertCanAllocateSentenceId(id)
      pair.nextId = id + 1
      const created: SavedSentence = {
        id,
        nativeLanguage,
        sourceLanguage: draft.sourceLanguage,
        targetLanguage: draft.targetLanguage,
        learningLanguage: draft.learningLanguage,
        originalText: draft.originalText,
        translatedText: draft.translatedText,
        tone: draft.tone,
        createdAt: now,
        savedAt: now,
        studyCount: studied ? 1 : 0,
        lastReviewedAt: studied ? now : null,
        masteryScore: DEFAULT_MASTERY_SCORE,
        knowledgePoints: mergePoints([], draft.knowledgePoints, draft.learningLanguage)
      }
      pair.records.push(created)
      return created
    }
    existing.originalText = draft.originalText
    existing.translatedText = draft.translatedText
    existing.tone = draft.tone
    // The relation travels with the draft, so a re-save cannot leave the sentence filed under
    // something the user is no longer learning. createdAt stays: the moment did not change.
    existing.nativeLanguage = nativeLanguage
    existing.learningLanguage = draft.learningLanguage
    existing.savedAt = now
    existing.knowledgePoints = mergePoints(
      existing.knowledgePoints,
      draft.knowledgePoints,
      draft.learningLanguage
    )
    // One more pass over the same words. What a review has already decided about them stands:
    // going over a sentence again is not evidence of forgetting it.
    if (studied) {
      existing.studyCount += 1
      existing.lastReviewedAt = now
    }
    return existing
  }

  /**
   * Deletes one sentence and everything under it. Its id is not returned to the pool: the
   * counter is left where it is, so the next sentence gets a number that was never used.
   */
  remove(ref: SavedSentenceRef): SavedSentence[] {
    const pair = this.languages[ref.nativeLanguage]?.[ref.learningLanguage]
    if (pair !== undefined) {
      pair.records = pair.records.filter((sentence) => sentence.id !== ref.id)
      this.persist()
    }
    return this.list()
  }

  /**
   * Deletes every sentence. The per-relation counters survive on purpose: "never reuse an id" is a
   * property of the relation, not of how many sentences happen to be in it right now.
   */
  clear(): SavedSentence[] {
    for (const byLearning of Object.values(this.languages)) {
      for (const pair of Object.values(byLearning)) pair.records = []
    }
    this.persist()
    return this.list()
  }

  private allSentences(): SavedSentence[] {
    const sentences: SavedSentence[] = []
    for (const byLearning of Object.values(this.languages)) {
      for (const pair of Object.values(byLearning)) sentences.push(...pair.records)
    }
    return sentences
  }

  private persist(): void {
    this.backupBeforeShapeWrite()
    writeJsonAtomic(this.filePath, { version: LANGUAGE_VERSION, languages: this.languages })
  }

  /**
   * Copies a file that is only missing the newer fields aside, once, immediately before the write
   * that brings it up to date - the same .vN.bak the structural upgrades leave behind. The flag is
   * cleared only after the copy lands, so a failed backup stops the write instead of letting it
   * replace the only copy of what the user had.
   */
  private backupBeforeShapeWrite(): void {
    const fromVersion = this.pendingFromVersion
    if (fromVersion === null) return
    backupFile(this.filePath, upgradeBackupPath(this.filePath, fromVersion))
    this.pendingFromVersion = null
  }

  /**
   * Writes the upgraded file once. The old one is copied aside first (learned.json.v4.bak,
   * learned.json.v5.bak, ...) and the new one goes through the same atomic write as every other
   * save, so the file being read is either fully replaced or exactly as it was.
   *
   * A failure here is deliberately not fatal: a read-only or full disk must not stop the app from
   * opening. The migrated sentences are already in memory, the old file is untouched, and the next
   * successful write brings the shape up to date.
   */
  private persistUpgrade(fromVersion: number | null): void {
    try {
      backupFile(this.filePath, upgradeBackupPath(this.filePath, fromVersion))
      this.persist()
    } catch {
      // Left for the next write.
    }
  }
}

/*
 * ---------------------------------------------------------------------------------------------
 * Reading the file. Four shapes exist in the wild: v7 and v6 (one bucket per relation, differing
 * only in the fields added since), v5 (one bucket per direction), v4 (one saved point per record)
 * and the file that came before it (a bare list of points). Everything unreadable is dropped rather than thrown, because a
 * hand-edited file must not stop the app from opening.
 * ---------------------------------------------------------------------------------------------
 */

interface ReadResult {
  library: LanguageLibrary
  /** True when the file on disk was an older shape and the upgrade still has to be written. */
  upgraded: boolean
  /** The version the file stated, for naming its backup. null when it stated none. */
  fromVersion: number | null
  /**
   * The version an up-to-date shape was read from: it needs no restructuring, so nothing is
   * written now and the next write brings it up to date behind a backup.
   */
  pendingFromVersion: number | null
}

/** Joins the parts of an identity. Never appears in a language code or in user text. */
const SEPARATOR = '\u0000'

function readLanguageFile(filePath: string): ReadResult {
  const nothing: ReadResult = {
    library: emptyLibrary(),
    upgraded: false,
    fromVersion: null,
    pendingFromVersion: null
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return nothing
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return nothing
  }
  if (typeof parsed !== 'object' || parsed === null) return nothing
  const source = parsed as Record<string, unknown>
  const fromVersion = typeof source.version === 'number' ? source.version : null
  // A file already filed by relation is read as it is, whatever the minor version: the fields
  // added since simply read with their defaults, and the file is left alone until a real write.
  if (fromVersion !== null && fromVersion >= RELATION_FILED_SINCE) {
    return {
      library: readLibrary(source.languages),
      upgraded: false,
      fromVersion,
      // Already current: nothing to write later.
      pendingFromVersion: fromVersion < LANGUAGE_VERSION ? fromVersion : null
    }
  }
  // An older file is read into the shape it was written in first, and then filed by relation. Both
  // v5 (one bucket per direction) and v4 (one point per record) come out of the first step as the
  // same in-memory shape, so the second step has one job no matter what it is looking at.
  const stored = fromVersion === 5 ? readLibrary(source.languages) : upgradeFromLegacy(source)
  // A file with nothing recognisable in it is not an upgrade: leave it alone rather than
  // rewriting an empty file over whatever the user happens to have there.
  if (stored === null) return nothing
  const { library, report } = mergeDirectionsIntoPairs(stored)
  logUpgrade(report)
  return { library, upgraded: true, fromVersion, pendingFromVersion: null }
}

/**
 * One line about the upgrade, which is the only write in this app that nobody asked for. Silent
 * when nothing had to move, so opening a current file does not chatter.
 *
 * It reports what the move itself did: the buckets it collapsed, the sentences it refiled under
 * their relation, and the ids it had to shift. How many relations were recovered from a direction
 * is not among them, and cannot be: the reader resolves that while it parses, so nothing reaches
 * the move without a relation, and a count taken there would always read zero.
 */
function logUpgrade(report: PairMergeReport): void {
  if (report.movedSentences === 0 && report.remappedIds.length === 0) return
  console.log(
    '[ctoe] learned.json filed by relation: ' +
      String(report.directionsBefore) +
      ' direction(s) became ' +
      String(report.pairsAfter) +
      ' relation(s), ' +
      String(report.movedSentences) +
      ' sentence(s) moved, ' +
      String(report.remappedIds.length) +
      ' id(s) renumbered'
  )
}

function readLibrary(value: unknown): LanguageLibrary {
  const library = emptyLibrary()
  if (typeof value !== 'object' || value === null) return library
  for (const [sourceLanguage, byTarget] of Object.entries(value as Record<string, unknown>)) {
    if (!isLanguageCode(sourceLanguage)) continue
    if (typeof byTarget !== 'object' || byTarget === null) continue
    for (const [targetLanguage, raw] of Object.entries(byTarget as Record<string, unknown>)) {
      if (!isLanguageCode(targetLanguage)) continue
      const pair = readPair(raw)
      // A pair is kept while it has sentences, and also when its counter has already handed
      // numbers out: that counter is the only thing stopping a deleted #000001 from coming
      // back on the next save, so an empty pair is not the same as an unused one.
      if (pair.records.length === 0 && pair.nextId === MIN_SENTENCE_ID) continue
      const target = library[sourceLanguage] ?? {}
      target[targetLanguage] = pair
      library[sourceLanguage] = target
    }
  }
  return library
}

function readPair(value: unknown): LanguagePairFile {
  let storedNextId: unknown
  const records: SavedSentence[] = []
  if (typeof value === 'object' && value !== null) {
    const source = value as Record<string, unknown>
    storedNextId = source.nextId
    if (Array.isArray(source.records)) {
      for (const entry of source.records) {
        const sentence = readSentence(entry)
        if (sentence !== null) records.push(sentence)
      }
    }
  }
  return { nextId: readNextId(storedNextId, records), records }
}

/**
 * The counter a pair will use next. It is read from the file rather than computed from the
 * records: a stored counter knows about ids that were deleted, and a computed one would hand
 * those out a second time. Only a missing or unusable value falls back to "one past the
 * highest id here", which is the safest number that cannot collide with what is on disk.
 */
function readNextId(stored: unknown, records: readonly SavedSentence[]): number {
  if (typeof stored === 'number' && Number.isInteger(stored) && stored >= MIN_SENTENCE_ID) {
    return stored
  }
  let highest = MIN_SENTENCE_ID - 1
  for (const sentence of records) highest = Math.max(highest, sentence.id)
  return highest + 1
}

/**
 * The user's own language - the other half of the relation, with learningLanguage.
 *
 * The stored value is read when the file has one, and read off the direction when it does not,
 * which is every file written before the field existed. Reading it off the direction is exact,
 * because the studied side is always one of the two sides of the direction. A stored value that
 * contradicts the sentence (the same language as the one being learned) is not a relation, so the
 * direction wins instead. Only a file claiming all three sides are the same language has nothing
 * left to read, and it gets the app's own language rather than a guess.
 */
function resolveNativeLanguage(
  value: unknown,
  fields: DirectionFields,
  fallback: LanguageCode
): LanguageCode {
  if (isLanguageCode(value) && value !== fields.learningLanguage) return value
  return nativeLanguageOf(fields, fallback)
}

function readSentence(value: unknown): SavedSentence | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  // The id is how a sentence is addressed, so one that cannot be read cannot be kept: minting a
  // number here would collide with an id already in the file.
  if (!isSentenceId(source.id)) return null
  const originalText = readText(source.originalText)
  const translatedText = readText(source.translatedText)
  const sourceLanguage = resolveLanguageCode(source.sourceLanguage, DEFAULT_NATIVE_LANGUAGE)
  const targetLanguage = resolveLanguageCode(source.targetLanguage, DEFAULT_LEARNING_LANGUAGE)
  const learningLanguage = resolveLearningLanguage(
    source.learningLanguage,
    sourceLanguage,
    targetLanguage
  )
  const nativeLanguage = resolveNativeLanguage(
    source.nativeLanguage,
    { sourceLanguage, targetLanguage, learningLanguage },
    DEFAULT_NATIVE_LANGUAGE
  )
  const knowledgePoints = readPoints(source.knowledgePoints, learningLanguage)
  // A sentence with neither side and no point has nothing left to review.
  if (originalText.length === 0 && translatedText.length === 0 && knowledgePoints.length === 0) {
    return null
  }
  const savedAt = toIsoTime(source.savedAt)
  return {
    id: source.id,
    nativeLanguage,
    sourceLanguage,
    targetLanguage,
    learningLanguage,
    originalText,
    translatedText,
    tone: isTone(source.tone) ? source.tone : 'natural',
    createdAt: toIsoTime(source.createdAt),
    savedAt,
    // The points are the evidence for a file written before the field existed: they could only
    // have come from a study pass, while a record without any has never been studied.
    studyCount: readStudyCount(source.studyCount, knowledgePoints.length > 0),
    lastReviewedAt: readLastReviewedAt(source.lastReviewedAt, savedAt),
    masteryScore: readMasteryScore(source.masteryScore),
    knowledgePoints
  }
}

function readPoints(value: unknown, learningLanguage: LanguageCode): KnowledgePoint[] {
  if (!Array.isArray(value)) return []
  const points: KnowledgePoint[] = []
  for (const entry of value) {
    const item = readItem(entry)
    if (item === null) continue
    const source = entry as Record<string, unknown>
    const id = readText(source.id)
    points.push(
      toKnowledgePoint(
        item,
        readAudioLanguage(source.audioLanguage, learningLanguage),
        // A point keeps the id it was written with. The fallback only matters for a file that
        // was hand-edited or written before the field existed.
        id.length > 0 ? id : randomUUID()
      )
    )
  }
  return points
}

/*
 * ---------------------------------------------------------------------------------------------
 * The one-way upgrade from v4.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * Upgrades a v4 file (or the bare list of points that came before it) into sentences.
 *
 * v4 kept one point per record, so a sentence the user saved twice is two records sharing a
 * pair and both lines. The upgrade puts those back together: one sentence, its points merged,
 * with ids handed out oldest first so a migrated file reads in the order the moments happened.
 * Nothing that was saved is dropped, and nothing is written until the whole library is built.
 */
function upgradeFromLegacy(source: Record<string, unknown>): LanguageLibrary | null {
  const records = readLegacyRecords(source)
  if (records.length === 0) return null

  const library = emptyLibrary()
  const byIdentity = new Map<string, SavedSentence>()
  // savedAt ascending, and the old array order for anything saved in the same millisecond.
  const ordered = records
    .map((record, order) => ({ record, order }))
    .sort(
      (left, right) =>
        timeValue(toIsoTime(left.record.savedAt)) - timeValue(toIsoTime(right.record.savedAt)) ||
        left.order - right.order
    )

  for (const { record, order } of ordered) {
    const pair = ensurePair(library, record.sourceLanguage, record.targetLanguage)
    const identity = legacyIdentity(record) ?? 'solo' + SEPARATOR + String(order)
    const existing = byIdentity.get(identity)
    if (existing !== undefined) {
      // The same moment, saved again under v4: the later answer and studied side win, and the
      // points it came with join the ones already there.
      existing.translatedText = record.targetText
      existing.tone = record.tone
      existing.learningLanguage = record.learningLanguage
      existing.savedAt = toIsoTime(record.savedAt)
      existing.knowledgePoints = mergePoints(
        existing.knowledgePoints,
        record.items,
        existing.learningLanguage
      )
      continue
    }
    const id = pair.nextId
    // Out of numbers: the moments left over cannot be given ids without reusing one, so they are
    // left in the old file (which is kept as the backup) instead of being given a duplicate.
    if (id > MAX_SENTENCE_ID) break
    pair.nextId = id + 1
    pair.records.push({
      id,
      nativeLanguage: nativeLanguageOf(record, DEFAULT_NATIVE_LANGUAGE),
      sourceLanguage: record.sourceLanguage,
      targetLanguage: record.targetLanguage,
      learningLanguage: record.learningLanguage,
      originalText: record.sourceText,
      translatedText: record.targetText,
      tone: record.tone,
      createdAt: toIsoTime(record.savedAt),
      savedAt: toIsoTime(record.savedAt),
      // A v4 record exists because the user kept a point out of that moment, which is a study pass.
      studyCount: record.items.length > 0 ? 1 : 0,
      lastReviewedAt: toIsoTime(record.savedAt),
      masteryScore: DEFAULT_MASTERY_SCORE,
      knowledgePoints: mergePoints([], record.items, record.learningLanguage)
    })
    byIdentity.set(identity, pair.records[pair.records.length - 1])
  }
  return library
}

/**
 * The identity two v4 records share when they are one moment. Records with no sentence around
 * them are never merged: the oldest file kept bare points with nothing else, and folding those
 * together would invent a sentence the user never saw.
 */
function legacyIdentity(record: LearningRecord): string | null {
  const original = record.sourceText.trim()
  const translated = record.targetText.trim()
  if (original.length === 0 && translated.length === 0) return null
  return [
    record.sourceLanguage,
    record.targetLanguage,
    original,
    translated
  ].join(SEPARATOR)
}

/** v4 kept its records under 'records'; the file before it kept bare points under 'items'. */
function readLegacyRecords(source: Record<string, unknown>): LearningRecord[] {
  const records = readRecordArray(source.records)
  if (records.length > 0) return records
  return readBareItems(source.items)
}

/** A v4 record: one saved point inside the sentence it came from. */
function readRecordArray(value: unknown): LearningRecord[] {
  if (!Array.isArray(value)) return []
  const records: LearningRecord[] = []
  for (const entry of value) {
    const record = readRecord(entry)
    if (record !== null) records.push(record)
  }
  return records
}

function readRecord(value: unknown): LearningRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  const id = readText(source.id)
  if (id.length === 0) return null
  const items = readItems(source.items)
  const targetText = readText(source.targetText)
  // A record with neither the answer nor any point has nothing left to review.
  if (targetText.length === 0 && items.length === 0) return null
  // Records written before the app had more than one language pair default to the pair the app
  // shipped with, which is what they were actually written in.
  const sourceLanguage = resolveLanguageCode(source.sourceLanguage, DEFAULT_NATIVE_LANGUAGE)
  const targetLanguage = resolveLanguageCode(source.targetLanguage, DEFAULT_LEARNING_LANGUAGE)
  return {
    id,
    sourceText: readText(source.sourceText),
    targetText,
    tone: isTone(source.tone) ? source.tone : 'natural',
    sourceLanguage,
    targetLanguage,
    learningLanguage: resolveLearningLanguage(
      source.learningLanguage,
      sourceLanguage,
      targetLanguage
    ),
    items,
    savedAt: readTime(source.savedAt)
  }
}

/**
 * The pre-My-Language file was a flat list of points with no sentence around them. Each one
 * becomes its own record with empty texts, so an upgrade only ever adds structure.
 */
function readBareItems(value: unknown): LearningRecord[] {
  if (!Array.isArray(value)) return []
  const records: LearningRecord[] = []
  for (const entry of value) {
    const item = readItem(entry)
    if (item === null) continue
    const legacy = entry as Record<string, unknown>
    records.push({
      id: readText(legacy.id).length > 0 ? readText(legacy.id) : randomUUID(),
      sourceText: '',
      targetText: '',
      tone: isTone(legacy.tone) ? legacy.tone : 'natural',
      // The oldest file had no sentence at all, let alone languages.
      sourceLanguage: resolveLanguageCode(legacy.sourceLanguage, DEFAULT_NATIVE_LANGUAGE),
      targetLanguage: resolveLanguageCode(legacy.targetLanguage, DEFAULT_LEARNING_LANGUAGE),
      // Nothing in that file said which side was being studied, so the safe reading is the
      // language the app was teaching when it was written.
      learningLanguage: isLanguageCode(legacy.learningLanguage)
        ? legacy.learningLanguage
        : DEFAULT_LEARNING_LANGUAGE,
      items: [item],
      savedAt: readTime(legacy.savedAt)
    })
  }
  return records
}

/*
 * ---------------------------------------------------------------------------------------------
 * Points: the things a sentence is worth remembering for.
 * ---------------------------------------------------------------------------------------------
 */

/**
 * One point as it is stored: what the model said, plus the two things only the store knows.
 * The id is minted here so two runs cannot collide, and audioLanguage is frozen at save time,
 * so switching what the user is learning tomorrow cannot change how an old line is read out.
 */
function toKnowledgePoint(
  item: LearningItem,
  audioLanguage: LanguageCode,
  id: string = randomUUID()
): KnowledgePoint {
  return {
    id,
    kind: item.kind,
    expression: item.expression,
    meaning: item.meaning,
    why: item.why,
    example: item.example,
    exampleTranslation: item.exampleTranslation,
    // A file or an answer written before the field existed reads as the middle rank.
    importance: isKnowledgeImportance(item.importance) ? item.importance : DEFAULT_KNOWLEDGE_IMPORTANCE,
    audioLanguage
  }
}

/**
 * The point list a save produces: what was already kept plus every point of this answer that is
 * not already there. Nothing is ever removed by a save, so a second Learn pass over the same
 * sentence adds what it found instead of replacing the note.
 */
function mergePoints(
  kept: readonly KnowledgePoint[],
  items: readonly LearningItem[],
  learningLanguage: LanguageCode
): KnowledgePoint[] {
  const points = [...kept]
  const seen = new Set(points.map(knowledgePointKey))
  for (const item of items) {
    const point = toKnowledgePoint(item, learningLanguage)
    const key = knowledgePointKey(point)
    if (seen.has(key)) continue
    seen.add(key)
    points.push(point)
  }
  return points
}

/** The language a saved line is read in; a file without the field uses the sentence's. */
function readAudioLanguage(value: unknown, fallback: LanguageCode): LanguageCode {
  return isLanguageCode(value) ? value : fallback
}

function readItems(value: unknown): LearningItem[] {
  if (!Array.isArray(value)) return []
  const items: LearningItem[] = []
  for (const entry of value) {
    const item = readItem(entry)
    if (item !== null) items.push(item)
  }
  return items
}

function readItem(value: unknown): LearningItem | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  const expression = readText(source.expression)
  const meaning = readText(source.meaning)
  // Same rule as the Learn parser: without the language chunk and its meaning there is no point.
  if (expression.length === 0 || meaning.length === 0) return null
  return {
    kind: isLearningKind(source.kind) ? source.kind : 'expression',
    expression,
    meaning,
    why: readText(source.why),
    example: readText(source.example),
    // Files written before the field existed simply have no value for it.
    exampleTranslation: readText(source.exampleTranslation),
    importance: isKnowledgeImportance(source.importance) ? source.importance : undefined
  }
}

/**
 * The side of the pair a sentence teaches, which My Learning reads instead of assuming a
 * direction. Files written before the field existed came from the one pair the app shipped
 * with, where the learned side was English in both directions - so that is what they get.
 */
function resolveLearningLanguage(
  value: unknown,
  sourceLanguage: LanguageCode,
  targetLanguage: LanguageCode
): LanguageCode {
  if (isLanguageCode(value)) return value
  if (targetLanguage === DEFAULT_LEARNING_LANGUAGE) return targetLanguage
  if (sourceLanguage === DEFAULT_LEARNING_LANGUAGE) return sourceLanguage
  return targetLanguage
}

/**
 * How many study passes a record has had. A file written before the field existed says nothing, so
 * the points it holds are the evidence (see readSentence), and a record that was only ever kept
 * without being studied counts zero.
 */
function readStudyCount(value: unknown, hasPoints: boolean): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value
  return hasPoints ? 1 : 0
}

/** When the sentence was last studied. An explicit null means it never was. */
function readLastReviewedAt(value: unknown, savedAt: string): string | null {
  if (value === null) return null
  if (typeof value !== 'string' && typeof value !== 'number') return savedAt
  const read = toIsoTime(value)
  return read === FALLBACK_TIME_ISO ? savedAt : read
}

/** A score the file could have meant, clamped to the range the product defines. */
function readMasteryScore(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MASTERY_SCORE
  return Math.min(MASTERY_SCORE_MAX, Math.max(DEFAULT_MASTERY_SCORE, Math.trunc(value)))
}

function readText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readTime(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
