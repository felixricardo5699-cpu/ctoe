import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLanguageCode } from '@shared/language/registry'
import { DEFAULT_TONE, isTone } from '@shared/types'
import { nowIso, timeValue, toIsoTime } from '@shared/language/time'
import { RECENT_TRANSLATION_LIMIT, type RecentTranslation } from '@shared/types'
import { writeJsonAtomic } from '../storage/atomicJson'

/** The shape on disk. Bumped if a row ever changes; a file without it still reads. */
export const RECENT_VERSION = 1

/** The file's own name: the recent list is not learning material and does not share a file. */
export const RECENT_FILE_NAME = 'recent.json'

/** One translation to remember. The store owns the id and the time, so callers never guess them. */
export interface RecentTranslationDraft {
  sourceLanguage: RecentTranslation['sourceLanguage']
  targetLanguage: RecentTranslation['targetLanguage']
  /** The side being studied, which is what later makes the row learnable (see `learningLanguage`). */
  learningLanguage: RecentTranslation['sourceLanguage']
  /** What the moment was asked in, kept so a later Learn coaches it the same way. */
  tone: RecentTranslation['tone']
  sourceText: string
  targetText: string
}

/**
 * The recent translations: a short-lived list of what the user just translated, in its own file
 * next to config.json. Nothing here is study material, and nothing is bucketed by language pair -
 * a row is a moment, and the list is read newest first.
 *
 * Whether to keep such a list at all is the user's call (the config's recentPolicy), so this
 * store only knows how to keep one; the caller decides whether to hand it a row. Two rules it
 * does hold to: the list is capped, because 'recent' means short-lived, and a translation that is
 * already in the list is moved to the top rather than stored twice - regenerating a sentence, or
 * asking again after a failure, should not stack twins of the same moment.
 */
export class RecentStore {
  private constructor(
    private readonly filePath: string,
    private entries: RecentTranslation[]
  ) {}

  static open(filePath: string = join(app.getPath('userData'), RECENT_FILE_NAME)): RecentStore {
    return new RecentStore(filePath, readRecentFile(filePath))
  }

  get path(): string {
    return this.filePath
  }

  /** Every remembered translation, newest first. */
  list(): RecentTranslation[] {
    return [...this.entries]
  }

  /**
   * Remembers one translation. A row with the same pair and the same two texts is refreshed and
   * moved to the top instead of being added again, and the oldest row falls off once the list is
   * full.
   */
  record(draft: RecentTranslationDraft): RecentTranslation[] {
    const entry: RecentTranslation = {
      id: randomUUID(),
      sourceLanguage: draft.sourceLanguage,
      targetLanguage: draft.targetLanguage,
      learningLanguage: draft.learningLanguage,
      tone: draft.tone,
      sourceText: draft.sourceText,
      targetText: draft.targetText,
      createdAt: nowIso()
    }
    const kept = this.entries.filter((row) => !sameTranslation(row, entry))
    this.entries = [entry, ...kept].slice(0, RECENT_TRANSLATION_LIMIT)
    this.persist()
    return this.list()
  }

  /** Drops every row. The file stays where it is; only what is in it goes. */
  clear(): RecentTranslation[] {
    if (this.entries.length > 0) {
      this.entries = []
      this.persist()
    }
    return this.list()
  }

  private persist(): void {
    writeJsonAtomic(this.filePath, { version: RECENT_VERSION, entries: this.entries })
  }
}

/** Whether two rows are the same translation: same pair, same two texts. */
function sameTranslation(a: RecentTranslation, b: RecentTranslation): boolean {
  return (
    a.sourceLanguage === b.sourceLanguage &&
    a.targetLanguage === b.targetLanguage &&
    a.sourceText === b.sourceText &&
    a.targetText === b.targetText
  )
}

/** Newest first, by stored time. */
function sortNewestFirst(entries: RecentTranslation[]): RecentTranslation[] {
  return [...entries].sort((a, b) => timeValue(b.createdAt) - timeValue(a.createdAt))
}

/**
 * Reads the file, dropping any row that is not usable instead of failing the whole read: one
 * damaged row must not cost the user the rest of the list. An unreadable time reads as the epoch
 * rather than as now, so a damaged row can never masquerade as the newest one.
 */
function readRecentFile(filePath: string): RecentTranslation[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  if (typeof parsed !== 'object' || parsed === null) return []
  const entries = (parsed as Record<string, unknown>).entries
  if (!Array.isArray(entries)) return []
  const rows: RecentTranslation[] = []
  for (const value of entries) {
    const row = readEntry(value)
    if (row !== null) rows.push(row)
  }
  return sortNewestFirst(rows).slice(0, RECENT_TRANSLATION_LIMIT)
}

function readEntry(value: unknown): RecentTranslation | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  if (typeof source.id !== 'string' || source.id.length === 0) return null
  const sourceLanguage = isLanguageCode(source.sourceLanguage) ? source.sourceLanguage : null
  const targetLanguage = isLanguageCode(source.targetLanguage) ? source.targetLanguage : null
  if (sourceLanguage === null || targetLanguage === null) return null
  // A translation crosses languages; a row that does not is not one.
  if (sourceLanguage === targetLanguage) return null
  if (typeof source.sourceText !== 'string' || typeof source.targetText !== 'string') return null
  if (source.sourceText.length === 0 && source.targetText.length === 0) return null
  // The studied side and the tone are only read when they make sense; a row that predates them
  // keeps its place in the list and is simply not learnable (see recentMoment).
  const learningLanguage = isLanguageCode(source.learningLanguage) ? source.learningLanguage : null
  return {
    id: source.id,
    sourceLanguage,
    targetLanguage,
    ...(learningLanguage === null ? {} : { learningLanguage }),
    tone: isTone(source.tone) ? source.tone : DEFAULT_TONE,
    sourceText: source.sourceText,
    targetText: source.targetText,
    createdAt: toIsoTime(source.createdAt)
  }
}
