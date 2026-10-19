import {
  KNOWLEDGE_FIELD_LIMITS,
  KNOWLEDGE_POINT_SAFETY_LIMIT,
  isKnowledgeImportance,
  isLearningKind,
  type KnowledgeImportance,
  type LearningAnalysis,
  type LearningItem,
  type LearningKind,
  type Understanding
} from '../types'
import { knowledgePointKey } from '../language/items'
import { stripCodeFences } from '../utils/text'

/**
 * Ceiling for everything one note keeps, across all of its points, in characters. A real lesson
 * is a small fraction of this; it only stops a runaway answer from filling the panel and the
 * file. With the per-field limits it bounds one answer end to end.
 */
export const MAX_ANALYSIS_CHARS = 8000

/**
 * Ceiling for the whole-sentence meaning of an Understand answer - generous, because that field
 * is a sentence and not a label.
 */
export const MAX_MEANING_CHARS = 2000

/**
 * Turns one structured answer into the structure the UI renders - both of them: the Learn
 * note and the Understand note, which share the same points. Models are asked for bare
 * JSON, but they still like to wrap it in a fence or a sentence, so this is deliberately
 * forgiving about the outside and strict about the inside: anything without a usable
 * expression + meaning is dropped, a repeated point is folded into the one already there,
 * and an over-long field is cut to its limit instead of thrown away.
 *
 * How many points a sentence yields is the model's call, so only safety valves live here: a
 * count no real note reaches (KNOWLEDGE_POINT_SAFETY_LIMIT) and a total size budget
 * (MAX_ANALYSIS_CHARS). Neither is a product limit, and no point is ever dropped for being
 * marked low importance.
 *
 * Returns null when nothing usable came back - the caller reports that as a failure
 * instead of showing half a lesson.
 */
export function parseLearningAnalysis(raw: string): LearningAnalysis | null {
  const json = extractJsonObject(stripCodeFences(raw))
  if (json === null) return null

  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    return null
  }

  return toAnalysis(collectItems(readItemEntries(payload)))
}

/**
 * The same parse, for an answer that is still arriving: it keeps whatever items have
 * already closed and ignores the half-written tail. That is what lets the panel show the
 * first point while the model is still writing the second, and why a Learn answer that
 * never becomes valid JSON still ends up as a failed request rather than a partial lesson.
 */
export function parseLearningAnalysisPartial(raw: string): LearningAnalysis | null {
  const objects = readCompleteItemObjects(stripCodeFences(raw))
  if (objects.length === 0) return null

  const entries: unknown[] = []
  for (const object of objects) {
    try {
      entries.push(JSON.parse(object))
    } catch {
      // Closed braces but invalid JSON: say nothing about this one and wait for the rest.
    }
  }
  return toAnalysis(collectItems(entries))
}

function toAnalysis(items: LearningItem[]): LearningAnalysis | null {
  return items.length === 0 ? null : { items }
}

/** Finds the outermost {...} so leading prose or a trailing note does not break parsing. */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

function readItemEntries(payload: unknown): unknown[] {
  if (typeof payload !== 'object' || payload === null) return []
  const raw = (payload as Record<string, unknown>).items
  return Array.isArray(raw) ? raw : []
}

/**
 * Every complete {...} object inside the "items" array. Scanning instead of parsing is
 * what makes this work on a truncated string: an unbalanced brace simply never matches.
 */
function readCompleteItemObjects(text: string): string[] {
  const start = itemsArrayStart(text)
  if (start === -1) return []

  const objects: string[] = []
  let depth = 0
  let inString = false
  let escaped = false
  let objectStart = -1

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) objectStart = index
      depth += 1
      continue
    }
    if (char === '}') {
      if (depth === 0) break
      depth -= 1
      if (depth === 0 && objectStart !== -1) {
        objects.push(text.slice(objectStart, index + 1))
        objectStart = -1
      }
      continue
    }
    // The items array closed, so there is nothing after it worth scanning.
    if (char === ']' && depth === 0) break
  }
  return objects
}

/** Index of the '[' that opens the items array, or -1 while the stream has not reached it. */
function itemsArrayStart(text: string): number {
  const key = text.indexOf('"items"')
  if (key === -1) return -1
  return text.indexOf('[', key)
}

function collectItems(entries: unknown[]): LearningItem[] {
  const items: LearningItem[] = []
  const seen = new Set<string>()
  let chars = 0
  for (const entry of entries) {
    const item = readItem(entry)
    if (item === null) continue
    // A repeated chunk is never worth the user's 10 seconds. The key folds the kind in as well,
    // so a vocabulary note and an expression note that share words stay two separate points.
    const key = knowledgePointKey(item)
    if (seen.has(key)) continue
    seen.add(key)
    items.push(item)
    chars += itemChars(item)
    // Safety valves, not product limits: the sentence decides how many points it deserves, and
    // these only stop an answer that has gone badly wrong.
    if (items.length >= KNOWLEDGE_POINT_SAFETY_LIMIT) break
    if (chars >= MAX_ANALYSIS_CHARS) break
  }
  return items
}

/** Everything one point adds to the note, so the total budget can be checked as it grows. */
function itemChars(item: LearningItem): number {
  return (
    item.expression.length +
    item.meaning.length +
    item.why.length +
    item.example.length +
    item.exampleTranslation.length
  )
}

function readItem(entry: unknown): LearningItem | null {
  if (typeof entry !== 'object' || entry === null) return null
  const source = entry as Record<string, unknown>
  const expression = readText(source.expression, KNOWLEDGE_FIELD_LIMITS.text)
  // Without the chunk being learned or its meaning there is nothing to teach.
  if (expression.length === 0) return null
  const meaning = readText(source.meaning, KNOWLEDGE_FIELD_LIMITS.meaning)
  if (meaning.length === 0) return null

  const item: LearningItem = {
    kind: readKind(source.kind),
    expression,
    meaning,
    why: readText(source.why, KNOWLEDGE_FIELD_LIMITS.why),
    example: readText(source.example, KNOWLEDGE_FIELD_LIMITS.example),
    // Missing in answers from before the prompt asked for it: an empty string, never a crash.
    exampleTranslation: readText(
      source.exampleTranslation,
      KNOWLEDGE_FIELD_LIMITS.exampleTranslation
    )
  }
  const importance = readImportance(source.importance)
  // Left off when the model did not send a readable one, so importanceOf() fills the default.
  return importance === null ? item : { ...item, importance }
}

/** An unexpected kind still deserves to be shown; it just gets the generic label. */
function readKind(value: unknown): LearningKind {
  return isLearningKind(value) ? value : 'expression'
}

/**
 * The ranking hint, when the model sent one that can be read as such. Anything else leaves the
 * point without one - never dropped, only ordered by the default (see importanceOf).
 */
function readImportance(value: unknown): KnowledgeImportance | null {
  return isKnowledgeImportance(value) ? value : null
}

/** One field, trimmed and cut to its ceiling: an over-long value is shortened, not discarded. */
function readText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return text.length > max ? text.slice(0, max) : text
}


/**
 * Turns the Understand answer into its structure: what the read text means, plus the same
 * points Learn produces. Same contract as the Learn parse - forgiving around the JSON,
 * strict inside it, and null when there is no usable answer.
 */
export function parseUnderstanding(raw: string): Understanding | null {
  const json = extractJsonObject(stripCodeFences(raw))
  if (json === null) return null

  let payload: unknown
  try {
    payload = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof payload !== 'object' || payload === null) return null
  const meaning = readText((payload as Record<string, unknown>).meaning, MAX_MEANING_CHARS)
  // Without the meaning there is no Understand answer, only a list of loose points.
  if (meaning.length === 0) return null
  return { meaning, items: collectItems(readItemEntries(payload)) }
}

/**
 * The meaning of an Understand answer that is still arriving, decoded up to the last
 * complete character. Every call returns the whole snapshot rather than a slice: the panel
 * replaces that box instead of appending, so half an escape sequence can never reach the
 * screen. An empty string means the stream has not reached the meaning yet.
 */
export function readStreamedMeaning(raw: string): string {
  return readTopLevelString(stripCodeFences(raw), 'meaning')
}

interface StringToken {
  /** Decoded value: whatever has arrived when the string has not closed yet. */
  value: string
  /** Just past the closing quote, or the end of the text while the string is still open. */
  end: number
  closed: boolean
}

/** The single-character escapes a JSON string can carry. */
function decodeEscape(char: string): string | null {
  if (char === '"') return '"'
  if (char === '\\') return '\\'
  if (char === '/') return '/'
  if (char === 'n') return '\n'
  if (char === 't') return '\t'
  if (char === 'r') return '\r'
  if (char === 'b') return '\b'
  if (char === 'f') return '\f'
  return null
}

/**
 * Reads one JSON string starting at its opening quote. Deliberately tolerant: an escape
 * that is still in flight, or a closing quote that has not arrived, simply ends the value -
 * which is exactly what a streamed answer looks like in the gap between two chunks.
 */
function readStringToken(text: string, start: number): StringToken {
  let index = start + 1
  let value = ''
  while (index < text.length) {
    const char = text[index] as string
    if (char === '"') return { value, end: index + 1, closed: true }
    if (char !== '\\') {
      value += char
      index += 1
      continue
    }
    const next = text[index + 1]
    if (next === undefined) break
    if (next === 'u') {
      const hex = text.slice(index + 2, index + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break
      value += String.fromCharCode(Number.parseInt(hex, 16))
      index += 6
      continue
    }
    const decoded = decodeEscape(next)
    if (decoded === null) break
    value += decoded
    index += 2
  }
  return { value, end: text.length, closed: false }
}

/**
 * A string field of the outermost object, read from an answer that may still be arriving.
 * Only depth-1 keys count, so a "meaning" inside the items array can never be mistaken for
 * the meaning of the answer itself.
 */
function readTopLevelString(text: string, wanted: string): string {
  const start = text.indexOf('{')
  if (start === -1) return ''
  let depth = 0
  let index = start
  while (index < text.length) {
    const char = text[index] as string
    if (char === '{') {
      depth += 1
      index += 1
      continue
    }
    if (char === '}') {
      depth -= 1
      if (depth <= 0) return ''
      index += 1
      continue
    }
    if (char !== '"') {
      index += 1
      continue
    }
    const token = readStringToken(text, index)
    if (depth !== 1) {
      index = token.end
      continue
    }
    let after = token.end
    while (after < text.length && isJsonSpace(text[after] as string)) after += 1
    // A key is followed by a colon; anything else at this depth is a value, so skip it.
    if (!token.closed || text[after] !== ':') {
      index = token.end
      continue
    }
    if (token.value !== wanted) {
      index = token.end
      continue
    }
    let valueStart = after + 1
    while (valueStart < text.length && isJsonSpace(text[valueStart] as string)) valueStart += 1
    if (text[valueStart] !== '"') return ''
    return readStringToken(text, valueStart).value
  }
  return ''
}

function isJsonSpace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\r' || char === '\t'
}
