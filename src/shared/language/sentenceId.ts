/*
 * Sentence ids: the number My Learning labels a saved sentence with, and the only place that
 * knows how it looks.
 *
 * An id is scoped to one language pair, so Chinese -> English and Chinese -> French both start
 * at 1. The counter is owned by the pair (see languageStore), never derived from the records:
 * deleting a sentence must not hand its number to the next one.
 *
 * Nothing else may build this string. The UI formats through formatSentenceId so a label can
 * never disagree with the number that is actually on disk.
 */

/** A sentence id is a positive 24-bit integer; 0 is "nothing allocated yet", never an id. */
export const MIN_SENTENCE_ID = 1

/** 0xFFFFFF (16,777,215): the end of one pair's id space. It never wraps around to 0. */
export const MAX_SENTENCE_ID = 0xffffff

/** Six hex digits is exactly the width of that space, so every label is the same length. */
export const SENTENCE_ID_DIGITS = 6

export const SENTENCE_ID_PREFIX = '#'

/** Stable code for "this language pair has handed out its last id". */
export const LANGUAGE_PAIR_ID_EXHAUSTED = 'LANGUAGE_PAIR_ID_EXHAUSTED'

/**
 * What the user is told when this happens. The failure crosses IPC, where only text survives,
 * so the code travels in the error and the UI turns it into this sentence - users never see
 * the number, and this is the one storage failure a person can actually act on.
 */
export const LANGUAGE_PAIR_ID_EXHAUSTED_MESSAGE = '这个语言对的编号已经用完，无法再保存新的句子。'

/**
 * Thrown when a pair would have to reuse an id. Storage raises it instead of wrapping or
 * overwriting, and the UI turns the code into a plain sentence - users never see the number.
 *
 * The message carries the code so it survives the trip through IPC, where an Error arrives as
 * text and a class does not.
 */
export class SentenceIdExhaustedError extends Error {
  readonly code: string = LANGUAGE_PAIR_ID_EXHAUSTED

  constructor(readonly nextId: number) {
    super(LANGUAGE_PAIR_ID_EXHAUSTED + ' (next id ' + String(nextId) + ')')
    this.name = 'SentenceIdExhaustedError'
  }
}

/** True for a value that could be a sentence id. Anything else is a bug, not a bad file. */
export function isSentenceId(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_SENTENCE_ID &&
    value <= MAX_SENTENCE_ID
  )
}

/**
 * Whether a pair's counter can still be handed out. The counter itself may sit one past the
 * last id (that is how "used up" is stored), so this is the check the allocator runs.
 */
export function canAllocateSentenceId(nextId: number): boolean {
  return isSentenceId(nextId)
}

/** Allocating past the end of the space is an error, never a fresh start at 1. */
export function assertCanAllocateSentenceId(nextId: number): void {
  if (!canAllocateSentenceId(nextId)) throw new SentenceIdExhaustedError(nextId)
}

/**
 * The label My Learning shows: '#' plus the id as six upper-case hex digits, so 1 reads
 * '#000001' and 0xA8F3 reads '#00A8F3'.
 */
export function formatSentenceId(id: number): string {
  // A whole number past the end of the space is an exhausted pair, which is worth saying out
  // loud. Anything else (0, a fraction, NaN) is a caller bug, so it is a plain range error.
  if (Number.isInteger(id) && id > MAX_SENTENCE_ID) throw new SentenceIdExhaustedError(id)
  if (!isSentenceId(id)) {
    throw new RangeError('not a sentence id: ' + String(id))
  }
  return SENTENCE_ID_PREFIX + id.toString(16).toUpperCase().padStart(SENTENCE_ID_DIGITS, '0')
}
