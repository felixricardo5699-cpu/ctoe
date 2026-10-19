// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeLanguageOf } from '@shared/language/pair'
import { sameSentenceIdentity } from '@shared/language/records'
import type { LanguageCode } from '@shared/language/registry'
import type {
  KnowledgePoint,
  LearningAnalysis,
  PublicSettings,
  SavedSentence,
  SavedSentenceDraft,
  TaskKind,
  Tone,
  TranslationErrorCode,
  TranslationFailure
} from '@shared/types'
import type { AssistantApi } from '@shared/types/api'
import type { TranslateDelta, TranslateDone, TranslateSentence } from '@shared/types/ipc'
import { AssistantPage } from './AssistantPage'

const SETTINGS: PublicSettings = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  tone: 'natural',
  providerKind: 'openai-compatible',
  nativeLanguage: 'zh',
  learningLanguage: 'en',
  hasApiKey: true,
  apiKeyEncrypted: true,
  floatingBall: true,
  globalShortcut: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  recentPolicy: 'off',
  browserBridgePolicy: 'off'
}

/** What the fake main process hands back for a Learn request. */
const LEARNED: LearningAnalysis = {
  items: [
    {
      kind: 'expression',
      expression: 'a bit too absolute',
      meaning: '有点太绝对',
      why: '比 too absolute 听起来更缓和',
      example: 'That sounds a bit too absolute to me.',
      exampleTranslation: '那听起来有点太绝对了。'
    },
    {
      kind: 'pattern',
      expression: 'I was going to',
      meaning: '我本来打算',
      why: '说「后来没做成」的计划',
      example: 'I was going to call you, but something came up.',
      exampleTranslation: '我本来想给你打电话，但临时有事。'
    }
  ]
}

interface StartCall {
  requestId: string
  text: string
  tone: Tone
  context: string
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
  task: TaskKind
  result: string
  /** Learn only: the moment the panel was showing, which is what the study pass files. */
  sentence?: TranslateSentence
}

interface Bridge {
  api: AssistantApi
  /** The clipboard the fake main process hands back to the input box. */
  clipboard: { text: string }
  startCalls: StartCall[]
  copyCalls: string[]
  cancelCalls: string[]
  panelCalls: string[]
  /** Every draft that reached the stand-in store, in order: what the app asked to keep. */
  savedRecords: SavedSentenceDraft[]
  /** What the fake store currently holds, so a delete can be checked. */
  records: SavedSentence[]
  /** Makes the next study pass fail with this code, the way a store that refuses would. */
  failNextLearn(code: TranslationErrorCode): void
  emitDelta(text: string): Promise<void>
  emitDeltaAnalysis(analysis: LearningAnalysis): Promise<void>
  emitUnderstanding(text: string, analysis: LearningAnalysis | null): Promise<void>
  emitDone(text: string, analysis?: LearningAnalysis | null): Promise<void>
  emitFailed(failure: TranslationFailure): Promise<void>
}

/** Stands in for the preload bridge: records calls and lets a test drive the stream. */
function createBridge(): Bridge {
  const deltas = new Set<(payload: TranslateDelta) => void>()
  const dones = new Set<(payload: TranslateDone) => void>()
  const failures = new Set<(payload: { requestId: string; failure: TranslationFailure }) => void>()
  const startCalls: StartCall[] = []
  const copyCalls: string[] = []
  const cancelCalls: string[] = []
  const panelCalls: string[] = []
  const savedRecords: SavedSentenceDraft[] = []
  const records: SavedSentence[] = []
  const clipboard = { text: '' }
  let nextId = 1
  /** The Learn request in flight, kept so the answer can file exactly what was studied. */
  let pendingLearn: StartCall | null = null
  /** Set by a test to make one study pass fail, then cleared by that pass. */
  let nextLearnFailure: TranslationErrorCode | null = null

  /**
   * The one place this stand-in writes a record, doing what the real store does with a draft: it
   * mints the id, stamps audioLanguage on every point, and merges a second commit into the record
   * that is already there rather than stacking a duplicate of the same moment.
   */
  const file = (draft: SavedSentenceDraft): SavedSentence => {
    savedRecords.push(draft)
    const knowledgePoints: KnowledgePoint[] = draft.knowledgePoints.map((item, index) => ({
      id: 'point-' + String(index),
      kind: item.kind,
      expression: item.expression,
      meaning: item.meaning,
      why: item.why,
      example: item.example,
      exampleTranslation: item.exampleTranslation,
      importance: item.importance ?? 'medium',
      audioLanguage: draft.learningLanguage
    }))
    const nativeLanguage = nativeLanguageOf(draft, 'zh')
    const existing = records.find((sentence) =>
      sameSentenceIdentity(sentence, { ...draft, nativeLanguage })
    )
    if (existing !== undefined) {
      existing.studyCount += 1
      existing.lastReviewedAt = existing.savedAt
      for (const point of knowledgePoints) {
        if (!existing.knowledgePoints.some((kept) => kept.expression === point.expression)) {
          existing.knowledgePoints.push(point)
        }
      }
      return existing
    }
    const record: SavedSentence = {
      id: nextId,
      nativeLanguage,
      sourceLanguage: draft.sourceLanguage,
      targetLanguage: draft.targetLanguage,
      learningLanguage: draft.learningLanguage,
      originalText: draft.originalText,
      translatedText: draft.translatedText,
      tone: draft.tone,
      createdAt: '2026-09-24T10:00:00.000Z',
      savedAt: '2026-09-24T10:00:00.000Z',
      studyCount: 1,
      lastReviewedAt: '2026-09-24T10:00:00.000Z',
      masteryScore: 0,
      knowledgePoints
    }
    nextId += 1
    records.unshift(record)
    return record
  }

  const api: AssistantApi = {
    getSettings: () => Promise.resolve(SETTINGS),
    saveSettings: (patch) => Promise.resolve({ ...SETTINGS, tone: patch.tone ?? SETTINGS.tone }),
    getAppInfo: () => Promise.resolve({ version: 'test', platform: 'test', configPath: 'test-config.json' }),
    copyText: (text) => {
      copyCalls.push(text)
      return Promise.resolve(true)
    },
    readText: () => Promise.resolve(clipboard.text),
    startTranslation: (payload) => {
      startCalls.push(payload)
      // Learn is the study act: the real main process files the sentence in the same round trip,
      // once it has the analysis in hand. The stand-in remembers what it was asked to study and
      // does the write when the answer arrives, which is that same moment.
      pendingLearn = payload.task === 'analyze' ? payload : null
      return Promise.resolve()
    },
    cancelTranslation: (requestId) => {
      cancelCalls.push(requestId)
      return Promise.resolve()
    },
    onDelta: (listener) => {
      deltas.add(listener)
      return () => {
        deltas.delete(listener)
      }
    },
    onDone: (listener) => {
      dones.add(listener)
      return () => {
        dones.delete(listener)
      }
    },
    onFailed: (listener) => {
      failures.add(listener)
      return () => {
        failures.delete(listener)
      }
    },
    expandPanel: () => Promise.resolve(),
    collapsePanel: () => {
      panelCalls.push('collapse')
      return Promise.resolve()
    },
    togglePanel: () => Promise.resolve(),
    hidePanel: () => {
      panelCalls.push('hide')
      return Promise.resolve()
    },
    quitApp: () => Promise.resolve(),
    getWindowMode: () => Promise.resolve({ mode: 'panel', anchor: 'below' }),
    onWindowMode: () => () => undefined,
    onOpenSettings: () => () => undefined,
    startBallDrag: () => Promise.resolve(),
    endBallDrag: () => Promise.resolve(),
    getShortcutStatus: () =>
      Promise.resolve({ ok: true, accelerator: 'CommandOrControl+Shift+Space', message: '' }),
    setShortcut: () => Promise.resolve({ ok: true, accelerator: 'CommandOrControl+Shift+Space', message: '' }),
    onShortcutStatus: () => () => undefined,
    listSavedSentences: () => Promise.resolve([...records]),
    saveSentence: (draft) => {
      file(draft)
      return Promise.resolve([...records])
    },
    removeSentence: (ref) => {
      const index = records.findIndex(
        (sentence) =>
          sentence.id === ref.id &&
          sentence.nativeLanguage === ref.nativeLanguage &&
          sentence.learningLanguage === ref.learningLanguage
      )
      if (index >= 0) records.splice(index, 1)
      return Promise.resolve([...records])
    },
    clearSentences: () => {
      records.length = 0
      return Promise.resolve([])
    },
    listRecentTranslations: () => Promise.resolve([]),
    clearRecentTranslations: () => Promise.resolve([]),
    getBridgeStatus: () => Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    resetBridgeToken: () => Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    onBridgeStatus: () => () => undefined,
    onLearnSentence: () => () => undefined,
    openExtensionFolder: () => Promise.resolve({ ok: true, folder: null, message: '' }),
    exportLearning: () =>
      Promise.resolve({ ok: true, folder: null, files: [], message: '' }),
    openDataFolder: () => Promise.resolve({ ok: true, folder: null, message: '' })
  }

  /**
   * The write that rides along with a Learn answer. A request that carried no sentence files
   * nothing rather than filing a guess, and a store that refuses is reported as a code.
   */
  const fileStudied = (
    analysis: LearningAnalysis | null
  ): { learned: SavedSentence | null; learnFailure: TranslationErrorCode | null } => {
    const studied = pendingLearn
    pendingLearn = null
    if (studied === null || analysis === null) return { learned: null, learnFailure: null }
    const sentence = studied.sentence
    if (sentence === undefined) return { learned: null, learnFailure: 'missing-sentence' }
    if (nextLearnFailure !== null) {
      const failure = nextLearnFailure
      nextLearnFailure = null
      return { learned: null, learnFailure: failure }
    }
    return {
      learned: file({
        originalText: sentence.originalText,
        translatedText: sentence.translatedText,
        tone: studied.tone,
        sourceLanguage: sentence.sourceLanguage,
        targetLanguage: sentence.targetLanguage,
        // The studied side is the language the note is about, which is what an analyze request
        // targets - the direction above is which way this moment went.
        learningLanguage: studied.targetLanguage,
        knowledgePoints: analysis.items
      }),
      learnFailure: null
    }
  }

  const currentId = (): string => startCalls[startCalls.length - 1]?.requestId ?? 'missing'
  const dispatch = async (run: () => void): Promise<void> => {
    await act(async () => {
      run()
    })
  }

  return {
    api,
    clipboard,
    startCalls,
    copyCalls,
    cancelCalls,
    panelCalls,
    savedRecords,
    records,
    failNextLearn: (code) => {
      nextLearnFailure = code
    },
    emitDelta: (text) =>
      dispatch(() => {
        for (const listener of deltas) listener({ requestId: currentId(), text })
      }),
    emitDeltaAnalysis: (analysis) =>
      dispatch(() => {
        for (const listener of deltas) listener({ requestId: currentId(), text: '', analysis })
      }),
    emitUnderstanding: (text, analysis) =>
      dispatch(() => {
        for (const listener of deltas) listener({ requestId: currentId(), text, analysis })
      }),
    emitDone: (text, analysis) =>
      dispatch(() => {
        const filed = fileStudied(analysis ?? null)
        for (const listener of dones) {
          listener({ requestId: currentId(), text, analysis, ...filed })
        }
      }),
    emitFailed: (failure) =>
      dispatch(() => {
        for (const listener of failures) listener({ requestId: currentId(), failure })
      })
  }
}

function setup(
  settings: PublicSettings = SETTINGS
): {
  bridge: Bridge
  onSaveSettings: ReturnType<typeof vi.fn>
  onOpenSettings: ReturnType<typeof vi.fn>
  onOpenLanguage: ReturnType<typeof vi.fn>
  onOpenRecent: ReturnType<typeof vi.fn>
} {
  const onOpenSettings = vi.fn()
  const onOpenLanguage = vi.fn()
  const onOpenRecent = vi.fn()
  const bridge = createBridge()
  window.api = bridge.api
  const onSaveSettings = vi.fn(() => Promise.resolve())
  render(
    <AssistantPage
      settings={settings}
      onSaveSettings={onSaveSettings}
      onOpenSettings={onOpenSettings}
      onOpenLanguage={onOpenLanguage}
      onOpenRecent={onOpenRecent}
    />
  )
  return { bridge, onSaveSettings, onOpenSettings, onOpenLanguage, onOpenRecent }
}

/**
 * The boxes are found by the shape of their placeholder rather than by the exact string: the
 * language names in them come from the profile, so the placeholders move when the pair does.
 */
const inputBox = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/写下你想说的意思/) as HTMLTextAreaElement
const outputBox = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/表达会显示在这里/) as HTMLTextAreaElement
const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement

/**
 * The line under the Learn note that says where the sentence went. There is nothing to press:
 * asking for the note is what filed it, so the panel only reports what happened.
 */
const receiptLines = (): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>('.analysis__saved'))
const receiptText = (): string => receiptLines()[0]?.textContent ?? ''

async function runTranslation(bridge: Bridge, chinese: string, english: string): Promise<void> {
  const user = userEvent.setup()
  await user.type(inputBox(), chinese)
  await user.click(button('Generate'))
  await bridge.emitDelta(english)
  await bridge.emitDone(english)
}

/** The English the user copied out of another app. */
const READ_ENGLISH = 'I was going to join you, but something came up.'
const READ_MEANING = '我本来打算加入你们，但临时有点事情。'

const meaningBox = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/意思会显示在这里/) as HTMLTextAreaElement
const originalBox = (): HTMLTextAreaElement =>
  screen.getByPlaceholderText(/把你在别处选中或复制的/) as HTMLTextAreaElement

afterEach(() => {
  cleanup()
  delete window.api
})

describe('AssistantPage', () => {
  it('keeps the question on screen and turns the typed Chinese into natural English', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    // The label is the product's whole framing, so it must not vanish once typing starts.
    expect(screen.getByText('What do you want to say?')).toBeDefined()

    await user.type(inputBox(), '我觉得这个说法太绝对了')
    expect(screen.getByText('What do you want to say?')).toBeDefined()
    await user.click(button('Generate'))

    expect(bridge.startCalls).toHaveLength(1)
    expect(bridge.startCalls[0]?.text).toBe('我觉得这个说法太绝对了')
    expect(bridge.startCalls[0]?.tone).toBe('natural')
    expect(bridge.startCalls[0]?.context).toBe('')
    expect(bridge.startCalls[0]?.task).toBe('express')
    expect(bridge.startCalls[0]?.result).toBe('')
    // The configured pair travels with the request instead of being assumed downstream.
    expect(bridge.startCalls[0]?.sourceLanguage).toBe('zh')
    expect(bridge.startCalls[0]?.targetLanguage).toBe('en')
    expect(screen.getByText('Generating...')).toBeDefined()

    await bridge.emitDelta('I think ')
    expect(outputBox().value).toBe('I think ')
    await bridge.emitDelta('that is a bit too absolute.')
    expect(outputBox().value).toBe('I think that is a bit too absolute.')

    await bridge.emitDone('I think that is a bit too absolute.')
    expect(screen.queryByText('Generating...')).toBeNull()
    expect(outputBox().value).toBe('I think that is a bit too absolute.')
  })

  it('locks the Generate button while loading and ignores extra triggers', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await user.type(inputBox(), '你好')
    await user.click(button('Generate'))
    expect(button('Generate').disabled).toBe(true)

    await user.click(button('Generate'))
    fireEvent.keyDown(window, { key: 'Enter', altKey: true })
    expect(bridge.startCalls).toHaveLength(1)

    await bridge.emitDone('Hello')
    await waitFor(() => expect(button('Generate').disabled).toBe(false))
  })

  it('shows a friendly message instead of the raw API error', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await user.type(inputBox(), '你好')
    await user.click(button('Generate'))
    await bridge.emitFailed({ code: 'unauthorized', detail: 'HTTP 401 Unauthorized' })

    expect(screen.getByRole('alert').textContent).toBe('API Key 无效，请检查设置。')
    expect(outputBox().value).toBe('')
  })

  it('copies the generated English and confirms it briefly', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')

    await user.click(button('Copy'))

    expect(bridge.copyCalls).toEqual(['Hello world'])
    await waitFor(() => expect(button('✓ Copied')).toBeDefined())
  })

  it('copies with Alt+Q', async () => {
    const { bridge } = setup()
    await runTranslation(bridge, '你好', 'Hello world')

    fireEvent.keyDown(window, { key: 'q', altKey: true })

    await waitFor(() => expect(bridge.copyCalls).toEqual(['Hello world']))
  })

  it('imports the clipboard into the input box, then generates from it', async () => {
    const { bridge } = setup()
    bridge.clipboard.text = '这个说法太绝对了。'
    const user = userEvent.setup()

    await user.click(button('从剪贴板粘贴'))

    expect(inputBox().value).toBe('这个说法太绝对了。')
    expect(screen.getByText('已粘贴')).toBeDefined()

    await user.click(button('Generate'))
    expect(bridge.startCalls[0]?.text).toBe('这个说法太绝对了。')
  })

  it('pastes at the caret instead of replacing what is already typed', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await user.type(inputBox(), 'AB')
    bridge.clipboard.text = 'X'
    inputBox().setSelectionRange(1, 1)

    await user.click(button('从剪贴板粘贴'))

    expect(inputBox().value).toBe('AXB')
  })

  it('keeps the typed text and explains itself when the clipboard is empty', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await user.type(inputBox(), '你好')

    await user.click(button('从剪贴板粘贴'))

    expect(inputBox().value).toBe('你好')
    expect(screen.getByText('剪贴板为空')).toBeDefined()
    expect(bridge.copyCalls).toEqual([])
  })

  it('copies the input back to the clipboard', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await user.type(inputBox(), '我想说这个')

    await user.click(button('复制输入内容'))

    await waitFor(() => expect(bridge.copyCalls).toEqual(['我想说这个']))
    expect(screen.getByText('已复制')).toBeDefined()
  })

  it('regenerates with the same text and tone', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')

    await user.click(button('重新生成'))

    expect(bridge.startCalls).toHaveLength(2)
    expect(bridge.startCalls[1]?.text).toBe(bridge.startCalls[0]?.text)
    expect(bridge.startCalls[1]?.tone).toBe('natural')
  })

  it('regenerates with Alt+R', async () => {
    const { bridge } = setup()
    await runTranslation(bridge, '你好', 'Hello world')

    fireEvent.keyDown(window, { key: 'r', altKey: true })

    await waitFor(() => expect(bridge.startCalls).toHaveLength(2))
    expect(bridge.startCalls[1]?.text).toBe('你好')
    expect(bridge.startCalls[1]?.task).toBe('express')
  })

  it('asks for input instead of spending an API call on nothing', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await user.click(button('Generate'))

    expect(bridge.startCalls).toHaveLength(0)
    expect(screen.getByRole('alert').textContent).toBe('请先输入你想表达的意思。')
  })

  it('offers Learn only once there is an expression to explain', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    expect(button('Learn').disabled).toBe(true)
    expect(screen.queryByLabelText('Learn 分析')).toBeNull()

    await runTranslation(bridge, '你好', 'Hello world')
    expect(button('Learn').disabled).toBe(false)

    await user.click(button('Learn'))
    expect(bridge.startCalls[1]?.task).toBe('analyze')
  })

  it('sends the finished expression back for coaching and shows the learn points', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '我觉得这个说法太绝对了', 'I think that is a bit too absolute.')

    await user.click(button('Learn'))

    expect(bridge.startCalls).toHaveLength(2)
    expect(bridge.startCalls[1]?.task).toBe('analyze')
    expect(bridge.startCalls[1]?.text).toBe('我觉得这个说法太绝对了')
    expect(bridge.startCalls[1]?.result).toBe('I think that is a bit too absolute.')
    expect(screen.getByText('Analyzing...')).toBeDefined()

    await bridge.emitDone('', LEARNED)

    expect(screen.queryByText('Analyzing...')).toBeNull()
    expect(screen.getByText('Learn this')).toBeDefined()
    expect(screen.getByText('a bit too absolute')).toBeDefined()
    expect(screen.getByText('有点太绝对')).toBeDefined()
    expect(screen.getByText('为什么有用：比 too absolute 听起来更缓和')).toBeDefined()
    expect(screen.getByText('例句：That sounds a bit too absolute to me.')).toBeDefined()
    // Every example comes with its meaning in the user own language, not only the English.
    expect(screen.getByText('那听起来有点太绝对了。')).toBeDefined()
    expect(screen.getByText('我本来想给你打电话，但临时有事。')).toBeDefined()
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(2)
    // The expression itself is untouched by Learn.
    expect(outputBox().value).toBe('I think that is a bit too absolute.')
  })

  it('offers read-aloud for the language being learned, and never for the user own words', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '我觉得这个说法太绝对了', 'I think that is a bit too absolute.')

    // Say it answers in the language being learned, so the answer box can be read out...
    expect(screen.getByLabelText('朗读：表达')).toBeDefined()
    // ...while the box the user wrote Chinese in cannot: they already know how that sounds.
    expect(screen.queryByLabelText('朗读：原文')).toBeNull()

    await user.click(button('Understand'))
    await user.type(originalBox(), READ_ENGLISH)

    // The other direction flips it: now the English the user read is the readable side.
    expect(screen.getByLabelText('朗读：原文')).toBeDefined()
    expect(screen.queryByLabelText('朗读：表达')).toBeNull()
  })

  it('keeps the previous learn points when a later Learn fails', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')

    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)
    expect(screen.getByText('Learn this')).toBeDefined()

    await user.click(button('Learn'))
    await bridge.emitFailed({ code: 'timeout', detail: 'request timed out' })

    expect(screen.getByRole('alert').textContent).toBe('AI 服务响应超时，请重试。')
    expect(screen.getByText('Learn this')).toBeDefined()
    expect(outputBox().value).toBe('Hello world')
  })

  it('drops the old learn points as soon as a new expression is generated', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')
    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    await user.click(button('重新生成'))

    expect(screen.queryByText('Learn this')).toBeNull()
    expect(outputBox().value).toBe('')
  })

  it('closes the learn note on request, keeping the expression', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '我觉得这个说法太绝对了', 'I think that is a bit too absolute.')
    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)
    expect(screen.getByText('Learn this')).toBeDefined()

    await user.click(screen.getByLabelText('收起 Learn 分析'))

    expect(screen.queryByText('Learn this')).toBeNull()
    // Closing the note is not the same as losing the answer, and Learn stays available.
    expect(outputBox().value).toBe('I think that is a bit too absolute.')
    expect((button('Learn') as HTMLButtonElement).disabled).toBe(false)
    await user.click(button('Learn'))
    expect(bridge.startCalls[2]?.task).toBe('analyze')
  })

  it('stops a learn note that is still streaming when it is closed', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')

    await user.click(button('Learn'))
    // The first points land mid-stream, which is when the block becomes closable.
    await bridge.emitDeltaAnalysis(LEARNED)
    expect(screen.getByText('Learn this')).toBeDefined()

    await user.click(screen.getByLabelText('收起 Learn 分析'))

    expect(screen.queryByText('Learn this')).toBeNull()
    expect(screen.queryByText('Analyzing...')).toBeNull()
    const learnCall = bridge.startCalls[1]
    expect(learnCall?.task).toBe('analyze')
    expect(bridge.cancelCalls).toEqual([learnCall?.requestId])
    // A late reply from the cancelled request must not reopen what the user just closed.
    await bridge.emitDone('', LEARNED)
    expect(screen.queryByText('Learn this')).toBeNull()
    expect(outputBox().value).toBe('Hello world')
  })

  it('persists a tone change', async () => {
    const { onSaveSettings } = setup()
    const user = userEvent.setup()

    await user.selectOptions(screen.getByRole('combobox'), 'casual')

    expect(onSaveSettings).toHaveBeenCalledWith({ tone: 'casual' })
  })

  it('flags the mock provider so canned English is never mistaken for a real answer', () => {
    setup({ ...SETTINGS, providerKind: 'mock' })

    expect(screen.getByText('Mock 模式')).toBeDefined()
  })

  it('collapses the panel back into the floating ball', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await user.click(button('收起为悬浮球'))

    expect(bridge.panelCalls).toEqual(['collapse'])
  })

  it('hides the window to the tray', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await user.click(button('隐藏到托盘'))

    expect(bridge.panelCalls).toEqual(['hide'])
  })

  it('offers no collapse button in classic window mode', () => {
    setup({ ...SETTINGS, floatingBall: false })

    expect(screen.queryByRole('button', { name: '收起为悬浮球' })).toBeNull()
    expect(screen.getByRole('button', { name: '隐藏到托盘' })).toBeDefined()
  })

  it('shows each Learn point as soon as the stream finishes it', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')

    await user.click(button('Learn'))
    await bridge.emitDeltaAnalysis({ items: [LEARNED.items[0]] })

    // The first point is readable while the model is still writing the second.
    expect(screen.getByText('Learn this')).toBeDefined()
    expect(screen.getByText('a bit too absolute')).toBeDefined()
    expect(screen.queryByText('I was going to')).toBeNull()

    await bridge.emitDeltaAnalysis(LEARNED)
    expect(screen.getByText('I was going to')).toBeDefined()
  })

  it('restores the previous note when a streamed Learn fails midway', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')
    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    await user.click(button('Learn'))
    await bridge.emitDeltaAnalysis({ items: [LEARNED.items[1]] })
    // The half-arrived retry has taken over the panel...
    expect(screen.getByText('I was going to')).toBeDefined()
    expect(screen.queryByText('a bit too absolute')).toBeNull()

    await bridge.emitFailed({ code: 'network', detail: 'socket hang up' })

    // ...and a failed retry puts the note that was already there back.
    expect(screen.getByText('a bit too absolute')).toBeDefined()
    expect(screen.getByText('I was going to')).toBeDefined()
    expect(screen.getByRole('alert').textContent).toBe('连接 AI 服务失败，请检查网络后重试。')
  })

  it('files the whole sentence, with every point, the moment the user asks to learn it', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '我觉得这个说法太绝对了', 'I think that is a bit too absolute.')

    // Nothing is written until the user asks to learn something: a translation is not a study act.
    expect(bridge.savedRecords).toEqual([])

    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    expect(bridge.savedRecords).toHaveLength(1)
    expect(bridge.savedRecords[0]).toEqual({
      originalText: '我觉得这个说法太绝对了',
      translatedText: 'I think that is a bit too absolute.',
      tone: 'natural',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      // Say it studies what it produced, which is the learning-language side.
      learningLanguage: 'en',
      // The moment is what is kept, so every point Learn found travels with it - all of them,
      // rather than one point at a time. There is no button to press for any of this.
      knowledgePoints: LEARNED.items
    })
    // One write for the whole sentence, and the panel says which one it was.
    expect(bridge.records).toHaveLength(1)
    await waitFor(() => expect(receiptText()).toBe('Added to My Learning · #000001'))
  })

  it('says so instead of claiming a receipt when the write did not land', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')
    bridge.failNextLearn('storage-failed')

    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    // The note is still worth reading, so it stays - only the receipt is replaced by the reason.
    expect(screen.getByText('a bit too absolute')).toBeDefined()
    await waitFor(() => expect(receiptText()).toBe('学习记录没能写入，请再点一次 Learn 重试。'))
  })

  it('counts a second pass over the same sentence on the record it already filed', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')
    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)
    await waitFor(() => expect(receiptText()).toBe('Added to My Learning · #000001'))

    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    // One sentence, one number: learning it again is a second pass, never a second record.
    expect(bridge.records).toHaveLength(1)
    await waitFor(() => expect(receiptText()).toBe('Added to My Learning · #000001'))
  })

  it('says nothing about My Learning until the user has asked to learn something', async () => {
    const { bridge } = setup()
    await runTranslation(bridge, '你好', 'Hello world')

    // A generated sentence on its own has no lesson around it and nothing has been studied.
    expect(receiptLines()).toEqual([])
    expect(bridge.savedRecords).toEqual([])
  })

  it('offers the note only once the answer has settled', async () => {
    const bridge = setup().bridge
    const user = userEvent.setup()

    await user.click(button('Learn'))
    // Learn only ever describes an expression that is already on screen.
    expect(bridge.startCalls).toHaveLength(0)
    expect(receiptLines()).toEqual([])

    await user.type(inputBox(), '你好')
    await user.click(button('Generate'))
    await bridge.emitDelta('Hello world')
    // Mid-stream the answer is still arriving, so there is nothing settled to learn from yet.
    expect(button('Learn').disabled).toBe(true)

    await bridge.emitDone('Hello world')
    await waitFor(() => expect(button('Learn').disabled).toBe(false))

    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)
    await waitFor(() => expect(receiptText()).toBe('Added to My Learning · #000001'))
  })

  it('opens My Learning from the panel header', async () => {
    const { onOpenLanguage } = setup()
    const user = userEvent.setup()

    await user.click(button('My Learning'))

    expect(onOpenLanguage).toHaveBeenCalledTimes(1)
  })

  it('opens the recent list from the panel header, beside the other two pages', async () => {
    const { onOpenRecent } = setup()
    const user = userEvent.setup()

    // The three behind-the-panel pages sit together; nothing here reads or clears the list.
    await user.click(button('最近翻译'))

    expect(onOpenRecent).toHaveBeenCalledTimes(1)
  })
})

/**
 * The direction is never picked per run: it follows from the profile plus the mode, so these
 * tests switch modes and check which way the request went - and that Learn always coaches the
 * language being learned, from either side.
 */
describe('AssistantPage with two modes', () => {
  /** Presses a mode tab, the way a user switches between writing and reading. */
  async function switchMode(name: 'Say it' | 'Understand'): Promise<void> {
    const user = userEvent.setup()
    await user.click(button(name))
  }

  /** Reads the English copied out of another app, which is what Understand is for. */
  async function understandEnglish(): Promise<Bridge> {
    const bridge = setup().bridge
    const user = userEvent.setup()
    await user.click(button('Understand'))
    bridge.clipboard.text = READ_ENGLISH
    await user.click(button('从剪贴板粘贴'))
    return bridge
  }

  it('states the profile instead of asking which way to go', () => {
    setup()

    expect(screen.getByText('Native:')).toBeDefined()
    expect(screen.getByText('中文')).toBeDefined()
    expect(screen.getByText('Learning:')).toBeDefined()
    expect(screen.getByText('English')).toBeDefined()
    expect(button('Say it').getAttribute('aria-pressed')).toBe('true')
    expect(button('Understand').getAttribute('aria-pressed')).toBe('false')
    // The writing side is what the panel opens on, so its question is already on screen.
    expect(screen.getByText('What do you want to say?')).toBeDefined()
  })

  it('takes the direction from the profile, so another pair relabels the whole panel', async () => {
    const { bridge } = setup({ ...SETTINGS, learningLanguage: 'fr' })
    const user = userEvent.setup()

    expect(screen.getByText('Français')).toBeDefined()
    expect(inputBox().placeholder).toBe('用 中文 写下你想说的意思')
    expect(outputBox().placeholder).toBe('自然的 Français 表达会显示在这里')

    await user.type(inputBox(), '我觉得这个想法挺有意思')

    // Checked while nothing is in flight: the tabs are locked during a request, so the mode has
    // to change before Generate is pressed.
    await switchMode('Understand')
    expect(originalBox().placeholder).toBe('把你在别处选中或复制的 Français 粘贴到这里')
    expect(meaningBox().placeholder).toBe('这段内容的中文意思会显示在这里')

    await switchMode('Say it')
    await user.click(button('Generate'))

    // Say it is always the user's own language into the one being learned.
    expect(bridge.startCalls[0]?.sourceLanguage).toBe('zh')
    expect(bridge.startCalls[0]?.targetLanguage).toBe('fr')
  })

  it('reads the language being learned and answers in the user language', async () => {
    const bridge = await understandEnglish()
    const user = userEvent.setup()

    expect(screen.getByText('What does this mean?')).toBeDefined()
    expect(originalBox().value).toBe(READ_ENGLISH)
    // Tone is about producing the learning language, so reading someone else's words drops it.
    expect(screen.queryByRole('combobox')).toBeNull()

    await user.click(button('Explain'))

    expect(bridge.startCalls).toHaveLength(1)
    expect(bridge.startCalls[0]?.task).toBe('understand')
    expect(bridge.startCalls[0]?.text).toBe(READ_ENGLISH)
    // Reading walks the pair backwards: what is being read is what is being learned.
    expect(bridge.startCalls[0]?.sourceLanguage).toBe('en')
    expect(bridge.startCalls[0]?.targetLanguage).toBe('zh')
    expect(screen.getByText('Understanding...')).toBeDefined()

    await bridge.emitUnderstanding(READ_MEANING, { items: [LEARNED.items[0]] })
    expect(meaningBox().value).toBe(READ_MEANING)
    expect(screen.getByText('a bit too absolute')).toBeDefined()

    await bridge.emitDone(READ_MEANING, LEARNED)
    expect(screen.queryByText('Understanding...')).toBeNull()
    expect(meaningBox().value).toBe(READ_MEANING)
    // The points arrive with the meaning, so this direction never needs a second request.
    expect(screen.getByText('Learn this')).toBeDefined()
    expect(screen.getByText('I was going to')).toBeDefined()
  })

  it('coaches the language being learned from the writing side', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '我觉得这个想法挺有意思', 'I think the idea is pretty interesting.')

    await user.click(button('Learn'))

    // Learn is asked in the user's language about the sentence that was produced.
    expect(bridge.startCalls[1]?.task).toBe('analyze')
    expect(bridge.startCalls[1]?.text).toBe('我觉得这个想法挺有意思')
    expect(bridge.startCalls[1]?.result).toBe('I think the idea is pretty interesting.')
    expect(bridge.startCalls[1]?.sourceLanguage).toBe('zh')
    expect(bridge.startCalls[1]?.targetLanguage).toBe('en')
  })

  it('coaches the language being learned from the reading side too', async () => {
    const bridge = await understandEnglish()
    const user = userEvent.setup()
    await user.click(button('Explain'))
    await bridge.emitDone(READ_MEANING, LEARNED)

    await user.click(button('Learn'))

    // Same pair as the writing side, whatever mode asked: the studied sentence is the English
    // that was read, and the note about it is written in the user's own language.
    expect(bridge.startCalls).toHaveLength(2)
    expect(bridge.startCalls[1]?.task).toBe('analyze')
    expect(bridge.startCalls[1]?.text).toBe(READ_MEANING)
    expect(bridge.startCalls[1]?.result).toBe(READ_ENGLISH)
    expect(bridge.startCalls[1]?.sourceLanguage).toBe('zh')
    expect(bridge.startCalls[1]?.targetLanguage).toBe('en')
  })

  it('keeps each side draft when the mode changes', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await user.type(inputBox(), '你好')

    await user.click(button('Understand'))
    expect(originalBox().value).toBe('')

    bridge.clipboard.text = READ_ENGLISH
    await user.click(button('从剪贴板粘贴'))
    expect(originalBox().value).toBe(READ_ENGLISH)

    await user.click(button('Say it'))
    // Switching back finds the Chinese exactly where it was left.
    expect(inputBox().value).toBe('你好')
  })

  it('drops the answer on a mode change, because it belongs to the other direction', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await runTranslation(bridge, '你好', 'Hello world')
    expect(outputBox().value).toBe('Hello world')

    await user.click(button('Understand'))

    // An English answer has no business under a box the panel now reads as English.
    expect(meaningBox().value).toBe('')
    expect(screen.queryByText('What do you want to say?')).toBeNull()
    expect(screen.getByText('What does this mean?')).toBeDefined()
  })

  it('locks the mode tabs while a request runs', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await user.type(inputBox(), '你好')
    await user.click(button('Generate'))

    expect(button('Understand').disabled).toBe(true)

    await bridge.emitDone('Hello world')
    await waitFor(() => expect(button('Understand').disabled).toBe(false))
  })

  it('never calls the AI on its own, only when asked', async () => {
    const bridge = setup().bridge
    const user = userEvent.setup()
    bridge.clipboard.text = READ_ENGLISH

    await user.click(button('从剪贴板粘贴'))
    // Importing text is not a request, and neither is switching mode: both are local.
    await user.click(button('Understand'))

    expect(bridge.startCalls).toHaveLength(0)
  })

  it('says what to do when the clipboard has nothing in it', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await user.click(button('从剪贴板粘贴'))

    expect(screen.getByText('剪贴板为空')).toBeDefined()
    expect(inputBox().value).toBe('')
    expect(bridge.startCalls).toHaveLength(0)
  })

  it('asks for something to write instead of spending a call on an empty box', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await user.click(button('Generate'))

    expect(screen.getByText('请先输入你想表达的意思。')).toBeDefined()
    expect(bridge.startCalls).toHaveLength(0)
  })

  it('asks for something to read in the other mode', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()
    await user.click(button('Understand'))

    await user.click(button('Explain'))

    // The generic message would mislead here: nothing is being said, something is being read.
    expect(screen.getByText('请先粘贴或输入你想读懂的 English 内容。')).toBeDefined()
    expect(bridge.startCalls).toHaveLength(0)
  })

  it('lays the box out for a right-to-left language, following the language not the pair', async () => {
    setup({ ...SETTINGS, learningLanguage: 'ar' })
    const user = userEvent.setup()

    // Say it writes the user's own language, which is still written left to right.
    expect(inputBox().getAttribute('dir')).toBe('ltr')

    await user.click(button('Understand'))

    // Reading Arabic follows the language being read, and the answer follows its own content.
    expect(originalBox().getAttribute('dir')).toBe('rtl')
    expect(meaningBox().getAttribute('dir')).toBe('auto')
  })

  it('copies the meaning and keeps nothing on its own', async () => {
    const bridge = await understandEnglish()
    const user = userEvent.setup()
    await user.click(button('Explain'))
    await bridge.emitDone(READ_MEANING, LEARNED)

    await user.click(button('Copy'))

    expect(bridge.copyCalls).toEqual([READ_MEANING])
    // Reading is not studying: the meaning and the points beside it are not filed on their own.
    expect(bridge.savedRecords).toEqual([])
    expect(receiptLines()).toEqual([])
  })

  it('files the sentence of the language being learned, whichever way round it came in', async () => {
    const bridge = await understandEnglish()
    const user = userEvent.setup()
    await user.click(button('Explain'))
    await bridge.emitDone(READ_MEANING, LEARNED)

    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    expect(bridge.savedRecords).toHaveLength(1)
    expect(bridge.savedRecords[0]).toEqual({
      // The moment as it happened: the text that was read, then its meaning. The id is handed
      // out under the relation, so this shares a number sequence with the writing side.
      originalText: READ_ENGLISH,
      translatedText: READ_MEANING,
      tone: 'natural',
      // Reading is the same pair the other way round: the source is what is being learned.
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      learningLanguage: 'en',
      knowledgePoints: LEARNED.items
    })
    await waitFor(() => expect(receiptText()).toBe('Added to My Learning · #000001'))
  })

  it('files a sentence read from another app under the shelf it will be found on', async () => {
    const bridge = await understandEnglish()
    const user = userEvent.setup()
    await user.click(button('Explain'))
    await bridge.emitDone(READ_MEANING, LEARNED)

    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    // The moment went learning -> native, but the relation is the one the profile names: what the
    // user speaks and what they are learning. My Learning shelves by the relation, never by the
    // direction this one sentence happened to go in.
    const filed = bridge.records[0]
    expect(filed?.nativeLanguage).toBe('zh')
    expect(filed?.learningLanguage).toBe('en')
  })

  it('explains the same text again when asked to regenerate', async () => {
    const bridge = await understandEnglish()
    const user = userEvent.setup()
    await user.click(button('Explain'))
    await bridge.emitDone(READ_MEANING, LEARNED)

    await user.click(button('重新生成'))

    expect(bridge.startCalls).toHaveLength(2)
    expect(bridge.startCalls[1]?.task).toBe('understand')
    expect(bridge.startCalls[1]?.text).toBe(READ_ENGLISH)
    // The old meaning is not left on screen while the new one is being written.
    expect(meaningBox().value).toBe('')
  })

  it('explains with Alt+Enter too, and locks the primary button while it runs', async () => {
    const bridge = await understandEnglish()
    const user = userEvent.setup()

    await user.keyboard('{Alt>}{Enter}{/Alt}')

    expect(bridge.startCalls).toHaveLength(1)
    expect(bridge.startCalls[0]?.task).toBe('understand')
    expect(button('Explain').disabled).toBe(true)

    await bridge.emitDone(READ_MEANING, LEARNED)
    expect(button('Explain').disabled).toBe(false)
  })
})

/**
 * The first-run card is the only thing on the panel the user did not ask for, so it has two jobs:
 * say what is left to do, and disappear the moment it would be in the way.
 */
describe('AssistantPage first-run card', () => {
  it('names the three first steps while the panel is still empty', async () => {
    setup()

    await waitFor(() => {
      expect(screen.getByText('开始使用')).toBeDefined()
    })
    expect(screen.getByText('配置 AI')).toBeDefined()
    expect(screen.getByText('学第一句话')).toBeDefined()
    expect(screen.getByText('让浏览器也能学')).toBeDefined()
  })

  it('sends the user to settings from the step that is not done yet', async () => {
    const { onOpenSettings } = setup()
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByText('开始使用')).toBeDefined())
    await user.click(button('去设置'))

    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

  // The panel is a fixed-height window: a draft, an answer, or a Learn note all need the room the
  // card was using, and the card is the one block nobody came here to read.
  it('steps aside as soon as the panel has something in it', async () => {
    setup()
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByText('开始使用')).toBeDefined())

    await user.type(inputBox(), '我觉得这个说法太绝对了')

    expect(screen.queryByText('开始使用')).toBeNull()
  })

  it('stays away once there is a Learn note to read', async () => {
    const { bridge } = setup()
    const user = userEvent.setup()

    await waitFor(() => expect(screen.getByText('开始使用')).toBeDefined())
    await runTranslation(bridge, '我觉得这个说法太绝对了', 'I think that is a bit too absolute.')
    await user.click(button('Learn'))
    await bridge.emitDone('', LEARNED)

    expect(screen.queryByText('开始使用')).toBeNull()
  })
})
