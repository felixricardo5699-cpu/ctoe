// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGE_PAIR_ID_EXHAUSTED_MESSAGE } from '@shared/language/sentenceId'
import type { LearningAnalysis, SavedSentence } from '@shared/types'
import { AnalysisPanel } from './AnalysisPanel'

const ANALYSIS: LearningAnalysis = {
  items: [
    {
      kind: 'vocabulary',
      expression: 'a bit too absolute',
      meaning: '有点太绝对',
      why: '比 too absolute 听起来更缓和',
      example: 'That sounds a bit too absolute to me.',
      exampleTranslation: '那听起来有点太绝对了。'
    },
    {
      kind: 'grammar',
      expression: 'was going to',
      meaning: '本来打算',
      why: '表示后来没做成的计划',
      example: 'I was going to call you, but something came up.',
      exampleTranslation: '我本来想给你打电话，但临时有事。'
    }
  ]
}

/** The panel always knows which language is being studied; it is part of a point's identity. */
function renderPanel(props: Partial<Parameters<typeof AnalysisPanel>[0]> = {}): void {
  render(<AnalysisPanel analysis={ANALYSIS} learningLanguage="en" {...props} />)
}

/** Everything the note actually renders, so nothing that is only source text can hide in it. */
const noteText = (): string => document.querySelector('.analysis')?.textContent ?? ''

/**
 * A sentence as the Learn answer hands it back. The panel only reads the number off it: the write
 * itself happened in the main process, in the same round trip that produced the note.
 */
const FILED: SavedSentence = {
  id: 6,
  nativeLanguage: 'zh',
  learningLanguage: 'en',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  originalText: '我觉得这个说法太绝对了',
  translatedText: 'I think that is a bit too absolute.',
  tone: 'natural',
  createdAt: '2026-09-24T10:00:00.000Z',
  savedAt: '2026-09-24T10:00:00.000Z',
  studyCount: 1,
  lastReviewedAt: '2026-09-24T10:00:00.000Z',
  masteryScore: 0,
  knowledgePoints: []
}

afterEach(cleanup)

describe('AnalysisPanel', () => {
  it('renders nothing until the user asks to learn', () => {
    render(<AnalysisPanel analysis={null} learningLanguage="en" />)
    expect(screen.queryByText('Learn this')).toBeNull()
  })

  it('renders nothing for an empty result', () => {
    render(<AnalysisPanel analysis={{ items: [] }} learningLanguage="en" />)
    expect(screen.queryByText('Learn this')).toBeNull()
  })

  it('shows expression, meaning, why and example for every point', () => {
    renderPanel()

    expect(screen.getByText('Learn this')).toBeDefined()
    expect(screen.getByText('a bit too absolute')).toBeDefined()
    expect(screen.getByText('有点太绝对')).toBeDefined()
    expect(screen.getByText('为什么有用：比 too absolute 听起来更缓和')).toBeDefined()
    expect(screen.getByText('例句：That sounds a bit too absolute to me.')).toBeDefined()
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(2)
  })

  it('shows the example in the user own language, right under the example itself', () => {
    renderPanel()

    expect(screen.getByText('例句：That sounds a bit too absolute to me.')).toBeDefined()
    expect(screen.getByText('那听起来有点太绝对了。')).toBeDefined()
    // Separate lines, so a Chinese sentence is never mistaken for the English example.
    expect(document.querySelectorAll('.analysis__example-translation')).toHaveLength(2)
  })

  it('offers a speaker for every line in the language being learned', () => {
    renderPanel()

    expect(screen.getByLabelText('朗读：a bit too absolute')).toBeDefined()
    expect(screen.getByLabelText('朗读：That sounds a bit too absolute to me.')).toBeDefined()
    expect(screen.getByLabelText('朗读：was going to')).toBeDefined()
    // Two lines per point, and none for the meaning in the user own language.
    expect(document.querySelectorAll('.analysis .speak')).toHaveLength(4)
    expect(screen.queryByLabelText('朗读：有点太绝对')).toBeNull()
  })

  it('draws no speaker for a line the model left out', () => {
    render(
      <AnalysisPanel
        analysis={{
          items: [
            {
              kind: 'expression',
              expression: 'x',
              meaning: 'y',
              why: '',
              example: '',
              exampleTranslation: ''
            }
          ]
        }}
        learningLanguage="en"
      />
    )

    // One speaker for the only line that exists: the expression.
    expect(document.querySelectorAll('.analysis .speak')).toHaveLength(1)
  })

  it('labels what kind of point each one is', () => {
    renderPanel()

    expect(screen.getByText('词汇')).toBeDefined()
    expect(screen.getByText('语法')).toBeDefined()
  })

  it('offers a way to close the note when the panel owns one', () => {
    const onDismiss = vi.fn()
    renderPanel({ onDismiss })

    screen.getByLabelText('收起 Learn 分析').click()
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('shows no close button when nobody can handle it', () => {
    renderPanel()
    expect(screen.queryByLabelText('收起 Learn 分析')).toBeNull()
  })

  it('skips the optional rows the model left empty', () => {
    render(
      <AnalysisPanel
        analysis={{
          items: [
            {
              kind: 'expression',
              expression: 'x',
              meaning: 'y',
              why: '',
              example: '',
              exampleTranslation: ''
            }
          ]
        }}
        learningLanguage="en"
      />
    )

    expect(screen.getByText('x')).toBeDefined()
    expect(screen.getByText('y')).toBeDefined()
    expect(screen.queryByText(/为什么有用/)).toBeNull()
    expect(screen.queryByText(/例句/)).toBeNull()
  })

  it('says nothing about a write until a study pass has filed something', () => {
    renderPanel()

    // Learn and the filing happen together, so a note with no receipt is a note still in flight.
    expect(screen.queryByText(/Added to My Learning/)).toBeNull()
    expect(document.querySelectorAll('.analysis__footer')).toHaveLength(0)
  })

  it('names the sentence the study pass filed, under the number it was filed as', () => {
    renderPanel({ learned: FILED })

    // A receipt, not a button: there is nothing here to press and nothing to keep track of.
    expect(screen.getByRole('status').textContent).toBe('Added to My Learning · #000006')
    expect(screen.queryByRole('button', { name: /Save|My Learning/ })).toBeNull()
    expect(screen.getByRole('status').closest('.analysis__footer')).not.toBeNull()
    // The note is made of its header, its list and this footer. A comment left as JSX text would
    // be rendered as prose right in the middle of the lesson, which nothing here ever is.
    expect(noteText().endsWith('Added to My Learning · #000006')).toBe(true)
    expect(noteText()).not.toContain('//')
  })

  it('says why nothing was filed instead of showing a receipt', () => {
    renderPanel({ learnFailure: 'storage-failed' })

    expect(screen.queryByText(/Added to My Learning/)).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('学习记录没能写入，请再点一次 Learn 重试。')
  })

  it('explains an id space that ran out in words a person can act on', () => {
    renderPanel({ learnFailure: 'language-pair-id-exhausted' })

    expect(screen.getByRole('status').textContent).toBe(LANGUAGE_PAIR_ID_EXHAUSTED_MESSAGE)
  })

  it('answers how many points a sentence deserves, not a fixed number of them', () => {
    const long: LearningAnalysis = {
      items: Array.from({ length: 5 }, (_value, index) => ({
        kind: 'expression' as const,
        expression: 'point ' + String(index),
        meaning: '意思 ' + String(index),
        why: '',
        example: '',
        exampleTranslation: ''
      }))
    }

    render(<AnalysisPanel analysis={long} learningLanguage="en" />)

    expect(document.querySelectorAll('.analysis__item')).toHaveLength(5)
  })

  it('shows the points the model thought most useful first, keeping the rest', () => {
    const ranked: LearningAnalysis = {
      items: [
        { kind: 'vocabulary', expression: 'low one', meaning: 'm', why: '', example: '', exampleTranslation: '', importance: 'low' },
        { kind: 'expression', expression: 'high one', meaning: 'm', why: '', example: '', exampleTranslation: '', importance: 'high' },
        { kind: 'pattern', expression: 'middle one', meaning: 'm', why: '', example: '', exampleTranslation: '', importance: 'medium' }
      ]
    }

    render(<AnalysisPanel analysis={ranked} learningLanguage="en" />)

    const expressions = Array.from(document.querySelectorAll('.analysis__expression')).map(
      (node) => node.textContent
    )
    expect(expressions).toEqual(['high one', 'middle one', 'low one'])
  })
})
