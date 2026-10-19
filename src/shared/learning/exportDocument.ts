/*
 * Turning My Learning into something you can print.
 *
 * The app stores sentences, and a sentence is not a flashcard: it is a moment the user met real
 * language in. So the export is organised the way the data is - one document per learning
 * relation, every sentence with every point it holds - and then the same points re-cut by kind as
 * an index at the end. The index is what a learner actually prints: a vocabulary sheet is read by
 * scanning, but the sentence a word came from must stay findable, so every index row names the
 * numbers it belongs to.
 *
 * A relation is directional: Chinese -> English and English -> Chinese are two separate documents,
 * because they are two different things to study. The file name says which one it is, in English,
 * so a folder of exports sorts predictably and prints cleanly.
 *
 * This module produces a neutral document description (headings, paragraphs, tables) and knows
 * nothing about .docx, Word or disk. The writer lives in the main process; the renderer never sees
 * any of it. That split is what lets the layout be tested without a file.
 */

import { sentenceMode } from '../language/pair'
import {
  groupByLanguagePair,
  sortKnowledgePoints,
  sortSentencesNewestFirst
} from '../language/records'
import { languageName } from '../language/registry'
import { formatSentenceId } from '../language/sentenceId'
import { LEARNING_KIND_LABELS, type LearningKind, type SavedSentence } from '../types'

/** One thing a document is made of. The writer maps each shape onto OOXML. */
export type ExportBlock =
  | { kind: 'heading'; level: 1 | 2; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] }

export interface ExportDocument {
  /** File name only, without a directory. English, `<Native>_<Learning>.docx`. */
  fileName: string
  /** Printed as the document's own title, above the intro lines. */
  title: string
  /** Plain lines printed under the title. */
  intro: string[]
  blocks: ExportBlock[]
}

/** The order the index is printed in: the product's own usefulness ranking. */
const KIND_ORDER: readonly LearningKind[] = ['expression', 'pattern', 'vocabulary', 'grammar']

/** Columns of the per-sentence point table, and of the per-kind index. */
const POINT_HEADERS = ['类型', '表达', '意思', '为什么有用', '例句', '例句翻译']
const INDEX_HEADERS = ['表达', '意思', '例句', '例句翻译', '来自']

/** Longest list of sentence numbers one index row names before it gives up. */
const MAX_IDS_PER_ROW = 4

/**
 * One document per relation, newest relation first - the same order the My Learning landing page
 * shows, so printing follows the way the user already reads the list.
 */
export function exportDocuments(sentences: readonly SavedSentence[], now: Date): ExportDocument[] {
  return groupByLanguagePair(sentences).map((group) =>
    documentOf(group.nativeLanguage, group.learningLanguage, group.sentences, now)
  )
}

function documentOf(
  nativeLanguage: SavedSentence['nativeLanguage'],
  learningLanguage: SavedSentence['learningLanguage'],
  sentences: readonly SavedSentence[],
  now: Date
): ExportDocument {
  const ordered = sortSentencesNewestFirst(sentences)
  const pointCount = ordered.reduce((total, sentence) => total + sentence.knowledgePoints.length, 0)
  const pairLabel = languageName(nativeLanguage) + ' → ' + languageName(learningLanguage)

  const blocks: ExportBlock[] = [{ kind: 'heading', level: 1, text: '句子' }]
  for (const sentence of ordered) blocks.push(...sentenceBlocks(sentence))
  blocks.push(...indexBlocks(ordered))

  return {
    fileName: fileNameFor(nativeLanguage, learningLanguage),
    title: 'My Learning · ' + pairLabel,
    intro: [
      '本文件由 ctoe（AI Language Coach）导出。每个二级标题是一句你学过的话，下面是这句话的原文、' +
        '译文，以及当时从这句话里挑出的全部学习点；最后是按类型整理好的索引，方便打印出来复习。',
      '导出日期 ' + isoDate(now) + ' · ' + pairLabel + ' · 共 ' + ordered.length + ' 句 · ' +
        pointCount + ' 个学习点'
    ],
    blocks
  }
}

/**
 * `Chinese_English.docx` - English on purpose, and the direction stays in the name, because
 * "Chinese learning English" and "English learning Chinese" are different documents.
 */
function fileNameFor(
  nativeLanguage: SavedSentence['nativeLanguage'],
  learningLanguage: SavedSentence['learningLanguage']
): string {
  const native = languageName(nativeLanguage)
  const learning = languageName(learningLanguage)
  // belt and braces: the registry's names are plain ASCII today, but a future name must not be
  // able to produce an unopenable file.
  return (native + '_' + learning + '.docx').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
}

/** One sentence: its number, the moment it happened, both boxes, and every point found in it. */
function sentenceBlocks(sentence: SavedSentence): ExportBlock[] {
  const mode = sentenceMode(sentence) === 'understand' ? 'Understand' : 'Say it'
  const studied = sentence.studyCount > 1 ? ' · 学习 ' + sentence.studyCount + ' 次' : ''
  const blocks: ExportBlock[] = [
    {
      kind: 'heading',
      level: 2,
      text:
        formatSentenceId(sentence.id) + ' · ' + mode + ' · ' + isoDate(sentence.savedAt) + ' · ' +
        sentence.tone + studied
    },
    { kind: 'paragraph', text: '原文：' + oneLine(sentence.originalText) },
    { kind: 'paragraph', text: '译文：' + oneLine(sentence.translatedText) }
  ]
  const points = sortKnowledgePoints(sentence.knowledgePoints)
  if (points.length > 0) {
    blocks.push({
      kind: 'table',
      headers: [...POINT_HEADERS],
      rows: points.map((point) => [
        LEARNING_KIND_LABELS[point.kind],
        oneLine(point.expression),
        oneLine(point.meaning),
        oneLine(point.why),
        oneLine(point.example),
        oneLine(point.exampleTranslation)
      ])
    })
  }
  return blocks
}

/**
 * The same points, re-cut by kind, so a printed page can be a vocabulary sheet rather than a pile
 * of lessons. A row is de-duplicated on (expression, meaning) only: that is one thing worth
 * learning met twice, and it becomes one row naming both sentences. Nothing is lost - every point
 * is already printed in full under its own sentence above.
 */
function indexBlocks(sentences: readonly SavedSentence[]): ExportBlock[] {
  const blocks: ExportBlock[] = []
  for (const kind of KIND_ORDER) {
    const rows = indexRows(sentences, kind)
    if (rows.length === 0) continue
    blocks.push({ kind: 'heading', level: 1, text: LEARNING_KIND_LABELS[kind] })
    blocks.push({ kind: 'table', headers: [...INDEX_HEADERS], rows })
  }
  return blocks
}

function indexRows(sentences: readonly SavedSentence[], kind: LearningKind): string[][] {
  const rows = new Map<string, { cells: string[]; ids: string[] }>()
  // Newest first, so the example a reader meets first is the most recent one.
  for (const sentence of sentences) {
    for (const point of sortKnowledgePoints(sentence.knowledgePoints)) {
      if (point.kind !== kind) continue
      const key =
        point.expression.trim().toLowerCase() + '\u0000' + point.meaning.trim().toLowerCase()
      const existing = rows.get(key)
      if (existing !== undefined) {
        existing.ids.push(formatSentenceId(sentence.id))
        continue
      }
      rows.set(key, {
        cells: [
          oneLine(point.expression),
          oneLine(point.meaning),
          oneLine(point.example),
          oneLine(point.exampleTranslation)
        ],
        ids: [formatSentenceId(sentence.id)]
      })
    }
  }
  return [...rows.values()].map(({ cells, ids }) => [
    ...cells,
    ids.slice(0, MAX_IDS_PER_ROW).join('、') + (ids.length > MAX_IDS_PER_ROW ? ' 等' : '')
  ])
}

/** A cell is one paragraph, so a stored line break becomes a space rather than a layout surprise. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** The date a moment belongs to, as a reader would write it (and stable across time zones). */
function isoDate(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : ''
  return date.toISOString().slice(0, 10)
}
