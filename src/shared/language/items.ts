import type { LearningItem } from '../types'

/** The words alone, folded for comparison, so ' Sign  up for ' and 'sign up for' are one thing. */
export function expressionKey(expression: string): string {
  return expression.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Identity of one point inside a sentence: its kind plus its words, both folded.
 *
 * Used when a sentence is saved twice, to tell "the same point again" from "a second point":
 * 'expression' + 'figure out' and 'expression' + 'Figure  Out' are one point, while a
 * vocabulary note and an expression note that happen to share words are two. Sentences are the
 * only thing that gets stored on its own, so this key never leaves the merge.
 */
export function knowledgePointKey(point: Pick<LearningItem, 'kind' | 'expression'>): string {
  return point.kind + '\u0000' + expressionKey(point.expression)
}
