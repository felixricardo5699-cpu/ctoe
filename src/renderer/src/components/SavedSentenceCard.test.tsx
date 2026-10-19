// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgePoint, SavedSentence } from '@shared/types'
import { SavedSentenceCard } from './SavedSentenceCard'

function point(expression: string, over: Partial<KnowledgePoint> = {}): KnowledgePoint {
  return {
    id: 'p-' + expression,
    kind: 'expression',
    expression,
    meaning: '含义 ' + expression,
    why: '很常用',
    example: 'An example with ' + expression + '.',
    exampleTranslation: '含有 ' + expression + ' 的例句。',
    importance: 'medium',
    audioLanguage: 'en',
    ...over
  }
}

/** A Say it moment: the user wrote their own language and got the studied one back. */
function express(over: Partial<SavedSentence> = {}): SavedSentence {
  return {
    id: 1,
    nativeLanguage: 'zh',
    learningLanguage: 'en',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    originalText: '我本来想去',
    translatedText: 'I was going to go.',
    tone: 'natural',
    createdAt: '2026-09-24T10:00:00.000Z',
    savedAt: '2026-09-24T10:00:00.000Z',
    studyCount: 1,
    lastReviewedAt: '2026-09-24T10:00:00.000Z',
    masteryScore: 0,
    knowledgePoints: [],
    ...over
  }
}

/** The same relation the other way round: the studied language is what came in. */
function understand(over: Partial<SavedSentence> = {}): SavedSentence {
  return express({
    id: 2,
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    originalText: 'I was going to go.',
    translatedText: '我本来想去。',
    ...over
  })
}

/** Everything the card says, so a test can prove it stays quiet about what it holds back. */
const cardText = (): string => document.querySelector('.language__record')?.textContent ?? ''

afterEach(() => {
  cleanup()
})

describe('SavedSentenceCard', () => {
  it('shows the pair-local id, drawn as six hex digits', () => {
    render(<SavedSentenceCard sentence={express({ id: 10 })} onRemove={vi.fn()} />)

    expect(screen.getByText('#00000A')).toBeDefined()
  })

  it('says the moment went out from the native language, and speaks the answer', () => {
    render(<SavedSentenceCard sentence={express()} onRemove={vi.fn()} />)

    const badge = screen.getByText('Say it')
    expect(badge.getAttribute('title')).toBe('自己表达：Chinese → English')
    // The studied side is the one that can be heard; the user's own line is not read back to them.
    expect(screen.getByRole('button', { name: '朗读：I was going to go.' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '朗读：我本来想去' })).toBeNull()
  })

  it('says the moment was read the other way round, and speaks the line that came in', () => {
    render(<SavedSentenceCard sentence={understand()} onRemove={vi.fn()} />)

    const badge = screen.getByText('Understand')
    expect(badge.getAttribute('title')).toBe('读懂：English → Chinese')
    expect(screen.getByRole('button', { name: '朗读：I was going to go.' })).toBeDefined()
    expect(screen.queryByRole('button', { name: '朗读：我本来想去。' })).toBeNull()
  })

  it('says how much knowledge a sentence holds without showing any of it', () => {
    render(
      <SavedSentenceCard
        sentence={express({
          knowledgePoints: [
            point('something came up', { meaning: '临时有事' }),
            point('end up'),
            point('turn out')
          ]
        })}
        onRemove={vi.fn()}
      />
    )

    expect(screen.getByText('KNOWLEDGE · 3 points')).toBeDefined()
    // Folded: the count is there, the lesson itself is not.
    expect(screen.queryByText('something came up')).toBeNull()
    expect(screen.queryByText('临时有事')).toBeNull()
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(0)
    expect(screen.getByRole('button', { name: '展开知识点' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('opens one sentence up on request, showing every point it holds', async () => {
    const four = ['a', 'b', 'c', 'd'].map((letter) => point(letter))
    render(<SavedSentenceCard sentence={express({ knowledgePoints: four })} onRemove={vi.fn()} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '展开知识点' }))

    // No cap: a sentence of any length shows everything it holds once it is opened.
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(4)
    expect(screen.getByText('d')).toBeDefined()
    expect(screen.getByText('含义 d')).toBeDefined()
    expect(screen.getAllByText('为什么有用：很常用')).toHaveLength(4)
    expect(screen.getByText(/An example with d\./)).toBeDefined()
    expect(screen.getByText('含有 d 的例句。')).toBeDefined()
    expect(screen.getByRole('button', { name: '收起知识点' }).getAttribute('aria-expanded')).toBe('true')

    await user.click(screen.getByRole('button', { name: '收起知识点' }))

    expect(document.querySelectorAll('.analysis__item')).toHaveLength(0)
    expect(screen.getByText('KNOWLEDGE · 4 points')).toBeDefined()
  })

  it('counts one point as one', () => {
    render(<SavedSentenceCard sentence={express({ knowledgePoints: [point('turn out')] })} onRemove={vi.fn()} />)

    expect(screen.getByText('KNOWLEDGE · 1 point')).toBeDefined()
  })

  it('says a sentence holds no knowledge, and offers nothing to open', () => {
    render(<SavedSentenceCard sentence={express()} onRemove={vi.fn()} />)

    // Said even at zero, so a card never looks like it lost its lesson.
    expect(screen.getByText('KNOWLEDGE · 0 points')).toBeDefined()
    expect(screen.queryByRole('button', { name: /知识点/ })).toBeNull()
    // The fold note is a JSX comment, never something a reader should see on the card.
    expect(cardText()).not.toContain('//')
  })

  it('deletes the whole moment, addressed by its relation and not by its direction', async () => {
    const onRemove = vi.fn()
    render(<SavedSentenceCard sentence={understand()} onRemove={onRemove} />)
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '删除句子 #000002' }))

    // zh -> en is the id's scope; the sentence itself went the other way.
    expect(onRemove).toHaveBeenCalledWith({ nativeLanguage: 'zh', learningLanguage: 'en', id: 2 })
  })
})
