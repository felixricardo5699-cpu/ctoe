import { describe, expect, it } from 'vitest'
import type { KnowledgePoint, LearningKind, SavedSentence } from '../types'
import { exportDocuments, type ExportBlock } from './exportDocument'

const NOW = new Date('2026-10-19T08:00:00.000Z')

function point(
  kind: LearningKind,
  expression: string,
  meaning: string,
  example = '',
  exampleTranslation = ''
): KnowledgePoint {
  return {
    id: 'p-' + expression + '-' + meaning,
    kind,
    expression,
    meaning,
    why: 'why ' + expression,
    example,
    exampleTranslation,
    importance: 'high',
    audioLanguage: 'en'
  }
}

function sentence(overrides: Partial<SavedSentence> & Pick<SavedSentence, 'id'>): SavedSentence {
  return {
    nativeLanguage: 'zh',
    learningLanguage: 'en',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    originalText: '原文 ' + String(overrides.id),
    translatedText: 'translated ' + String(overrides.id),
    tone: 'natural',
    createdAt: '2026-10-01T00:00:00.000Z',
    savedAt: '2026-10-01T00:00:00.000Z',
    studyCount: 1,
    lastReviewedAt: null,
    masteryScore: 0,
    knowledgePoints: [],
    ...overrides
  }
}

function tables(blocks: readonly ExportBlock[]): Extract<ExportBlock, { kind: 'table' }>[] {
  return blocks.filter((block): block is Extract<ExportBlock, { kind: 'table' }> => block.kind === 'table')
}

/** The only table whose last column is `来自`: that is the category index, not a sentence. */
function indexTable(blocks: readonly ExportBlock[]): Extract<ExportBlock, { kind: 'table' }> | undefined {
  return tables(blocks).find((table) => table.headers[table.headers.length - 1] === '来自')
}

/** The document's own sections (level 1), which is what "分类索引" is made of. */
function sectionHeadings(blocks: readonly ExportBlock[]): string[] {
  return blocks
    .filter(
      (block): block is Extract<ExportBlock, { kind: 'heading' }> =>
        block.kind === 'heading' && block.level === 1
    )
    .map((block) => block.text)
}

/** Every heading, sentence headings included - what the reader scrolls past. */
function headings(blocks: readonly ExportBlock[]): string[] {
  return blocks
    .filter((block): block is Extract<ExportBlock, { kind: 'heading' }> => block.kind === 'heading')
    .map((block) => block.text)
}

describe('export: one document per learning relation', () => {
  it('keeps the two directions of a language pair apart', () => {
    const documents = exportDocuments(
      [
        sentence({ id: 1, nativeLanguage: 'zh', learningLanguage: 'en' }),
        sentence({ id: 1, nativeLanguage: 'en', learningLanguage: 'zh', sourceLanguage: 'en', targetLanguage: 'zh' })
      ],
      NOW
    )

    // "Chinese learning English" and "English learning Chinese" are two different things to study.
    expect(documents.map((document) => document.fileName).sort()).toEqual([
      'Chinese_English.docx',
      'English_Chinese.docx'
    ])
  })

  it('names the file in English after the direction', () => {
    const documents = exportDocuments([sentence({ id: 1 })], NOW)

    expect(documents).toHaveLength(1)
    expect(documents[0]?.fileName).toBe('Chinese_English.docx')
    expect(documents[0]?.title).toBe('My Learning · Chinese → English')
  })

  it('puts the newest relation first, like the page it mirrors', () => {
    const documents = exportDocuments(
      [
        sentence({ id: 1, savedAt: '2026-09-01T00:00:00.000Z' }),
        sentence({ id: 2, nativeLanguage: 'zh', learningLanguage: 'fr', targetLanguage: 'fr', savedAt: '2026-10-01T00:00:00.000Z' })
      ],
      NOW
    )

    expect(documents.map((document) => document.fileName)).toEqual(['Chinese_French.docx', 'Chinese_English.docx'])
  })
})

describe('export: what one document contains', () => {
  it('starts with the sentence section, then only the kinds that have points', () => {
    const documents = exportDocuments(
      [
        sentence({
          id: 1,
          knowledgePoints: [point('expression', 'come up', '临时有事', 'Something came up.', '临时有点事。')]
        })
      ],
      NOW
    )

    expect(sectionHeadings(documents[0]?.blocks ?? [])).toEqual(['句子', '表达'])
  })

  it('prints every point of a sentence in full, including the example pair', () => {
    const documents = exportDocuments(
      [
        sentence({
          id: 3,
          knowledgePoints: [
            point('expression', 'come up', '临时有事', 'Something came up.', '临时有点事。'),
            point('vocabulary', 'dozen', '一打')
          ]
        })
      ],
      NOW
    )

    const [sentenceTable] = tables(documents[0]?.blocks ?? [])
    expect(sentenceTable?.headers).toEqual(['类型', '表达', '意思', '为什么有用', '例句', '例句翻译'])
    expect(sentenceTable?.rows).toEqual([
      ['表达', 'come up', '临时有事', 'why come up', 'Something came up.', '临时有点事。'],
      ['词汇', 'dozen', '一打', 'why dozen', '', '']
    ])
  })

  it('leaves the table out of a sentence that has no points, but keeps the sentence', () => {
    const documents = exportDocuments([sentence({ id: 2 })], NOW)

    expect(sectionHeadings(documents[0]?.blocks ?? [])).toEqual(['句子'])
    expect(tables(documents[0]?.blocks ?? [])).toEqual([])
  })

  it('numbers the sentences and records the moment they happened', () => {
    const documents = exportDocuments(
      [sentence({ id: 7, savedAt: '2026-10-02T12:00:00.000Z', studyCount: 3 })],
      NOW
    )

    expect(headings(documents[0]?.blocks ?? [])).toEqual(['句子', '#000007 · Say it · 2026-10-02 · natural · 学习 3 次'])  })

  it('calls the other direction Understand', () => {
    const documents = exportDocuments(
      [sentence({ id: 2, sourceLanguage: 'en', targetLanguage: 'zh' })],
      NOW
    )

    expect(headings(documents[0]?.blocks ?? [])).toContain('#000002 · Understand · 2026-10-01 · natural')
  })

  it('opens with the counts a reader can check against the page', () => {
    const documents = exportDocuments(
      [
        sentence({ id: 1, knowledgePoints: [point('expression', 'a', '甲'), point('vocabulary', 'b', '乙')] }),
        sentence({ id: 2, knowledgePoints: [point('pattern', 'c', '丙')] })
      ],
      NOW
    )

    expect(documents[0]?.intro[1]).toBe(
      '导出日期 2026-10-19 · Chinese → English · 共 2 句 · 3 个学习点'
    )
  })
})

describe('export: the category index', () => {
  it('lists one row per distinct expression and names every sentence it came from', () => {
    const documents = exportDocuments(
      [
        sentence({ id: 5, savedAt: '2026-10-02T00:00:00.000Z', knowledgePoints: [point('expression', 'come up', '临时有事', 'Something came up.', '临时有点事。')] }),
        sentence({ id: 4, savedAt: '2026-10-01T00:00:00.000Z', knowledgePoints: [point('expression', 'Come up', '临时有事')] })
      ],
      NOW
    )

    const expressionTable = indexTable(documents[0]?.blocks ?? [])
    expect(expressionTable?.headers).toEqual(['表达', '意思', '例句', '例句翻译', '来自'])
    // One row, both moments: the index is read by scanning, and the ids are how it stays traceable.
    // The spelling kept is the newest one's - the row shows the example a reader meets first.
    expect(expressionTable?.rows).toHaveLength(1)
    expect(expressionTable?.rows[0]).toEqual([
      'come up',
      '临时有事',
      'Something came up.',
      '临时有点事。',
      '#000005、#000004'
    ])
  })

  it('keeps the same words apart when they mean different things', () => {
    const documents = exportDocuments(
      [
        sentence({
          id: 1,
          knowledgePoints: [
            point('vocabulary', 'point', '要点'),
            point('vocabulary', 'point', '分数')
          ]
        })
      ],
      NOW
    )

    // Same expression, two meanings: two rows, not one.
    expect(indexTable(documents[0]?.blocks ?? [])?.rows).toHaveLength(2)
  })

  it('puts the most useful kind first and omits the empty ones', () => {
    const documents = exportDocuments(
      [
        sentence({
          id: 1,
          knowledgePoints: [point('grammar', 'if I were', '虚拟语气'), point('expression', 'come up', '临时有事')]
        })
      ],
      NOW
    )

    expect(sectionHeadings(documents[0]?.blocks ?? [])).toEqual(['句子', '表达', '语法'])
  })
})
