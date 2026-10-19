// @vitest-environment jsdom
import { act } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecentFallback } from '@shared/language/recentLearn'
import type {
  LearningAnalysis,
  PublicSettings,
  RecentTranslation,
  SavedSentence,
  TranslationFailure
} from '@shared/types'
import type { AssistantApi } from '@shared/types/api'
import type { TranslateDone, TranslateStartPayload } from '@shared/types/ipc'
import { RecentTranslationsPage } from './RecentTranslationsPage'

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
  recentPolicy: 'on',
  browserBridgePolicy: 'off'
}

/** The profile the page is opened under, unless a test says otherwise. */
const PROFILE: RecentFallback = { nativeLanguage: 'zh', learningLanguage: 'en' }

/**
 * Two moments, newest first, and one of them the pair the other way round. Both say which side
 * of themselves was being studied, the way the store writes a row today.
 */
const ROWS: RecentTranslation[] = [
  {
    id: 'r-2',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    tone: 'casual',
    sourceText: '我本来想去，但是突然有事',
    targetText: 'I was going to go, but something came up.',
    createdAt: '2026-09-25T10:00:00.000Z'
  },
  {
    id: 'r-1',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    learningLanguage: 'en',
    tone: 'natural',
    sourceText: 'I was going to join you.',
    targetText: '我本来打算加入你们。',
    createdAt: '2026-09-24T10:00:00.000Z'
  }
]

/** A row written before the list recorded which side was being studied. */
const LEGACY: RecentTranslation = {
  id: 'r-0',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  sourceText: '我本来想去，但是突然有事',
  targetText: 'I was going to go, but something came up.',
  createdAt: '2026-09-23T10:00:00.000Z'
}

/** The sentence the first row is, once it has been studied. */
const SENTENCE: SavedSentence = {
  id: 1,
  nativeLanguage: 'zh',
  learningLanguage: 'en',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  originalText: '我本来想去，但是突然有事',
  translatedText: 'I was going to go, but something came up.',
  tone: 'casual',
  createdAt: '2026-09-25T10:00:00.000Z',
  savedAt: '2026-09-25T10:00:00.000Z',
  studyCount: 1,
  lastReviewedAt: '2026-09-25T10:00:00.000Z',
  masteryScore: 0,
  knowledgePoints: []
}

const ANALYSIS: LearningAnalysis = {
  items: [
    {
      kind: 'expression',
      expression: 'come up',
      meaning: '（事情）突然发生',
      why: '很常用的口语搭配',
      example: 'Something came up, so I stayed home.',
      exampleTranslation: '临时有事，所以我留在家里了。',
      importance: 'high'
    }
  ]
}

/** Only the recent and learning calls matter here, but the whole bridge is stubbed for type safety. */
function createApi(overrides: Partial<AssistantApi> = {}): AssistantApi {
  const stub: AssistantApi = {
    getSettings: () => Promise.resolve(SETTINGS),
    saveSettings: () => Promise.resolve(SETTINGS),
    getAppInfo: () => Promise.resolve({ version: 'test', platform: 'test', configPath: 'test.json' }),
    copyText: () => Promise.resolve(true),
    readText: () => Promise.resolve(''),
    startTranslation: () => Promise.resolve(),
    cancelTranslation: () => Promise.resolve(),
    onDelta: () => () => undefined,
    onDone: () => () => undefined,
    onFailed: () => () => undefined,
    expandPanel: () => Promise.resolve(),
    collapsePanel: () => Promise.resolve(),
    togglePanel: () => Promise.resolve(),
    hidePanel: () => Promise.resolve(),
    quitApp: () => Promise.resolve(),
    getWindowMode: () => Promise.resolve({ mode: 'panel', anchor: 'below' }),
    onWindowMode: () => () => undefined,
    onOpenSettings: () => () => undefined,
    startBallDrag: () => Promise.resolve(),
    endBallDrag: () => Promise.resolve(),
    getShortcutStatus: () => Promise.resolve({ ok: true, accelerator: '', message: '' }),
    setShortcut: () => Promise.resolve({ ok: true, accelerator: '', message: '' }),
    onShortcutStatus: () => () => undefined,
    listSavedSentences: () => Promise.resolve([]),
    saveSentence: () => Promise.resolve([]),
    removeSentence: () => Promise.resolve([]),
    clearSentences: () => Promise.resolve([]),
    listRecentTranslations: () => Promise.resolve([]),
    getBridgeStatus: () => Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    resetBridgeToken: () => Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    onBridgeStatus: () => () => undefined,
    onLearnSentence: () => () => undefined,
    openExtensionFolder: () => Promise.resolve({ ok: true, folder: null, message: '' }),
    exportLearning: () =>
      Promise.resolve({ ok: true, folder: null, files: [], message: '' }),
    openDataFolder: () => Promise.resolve({ ok: true, folder: null, message: '' }),
    clearRecentTranslations: () => Promise.resolve([])
  }
  return { ...stub, ...overrides }
}

/**
 * A bridge that records every Learn request and lets the test deliver its answer, so a row can
 * be walked from the button press to the receipt the way the panel walks it.
 */
function learnApi(
  options: { rows?: RecentTranslation[]; sentences?: SavedSentence[] } = {}
): {
  api: AssistantApi
  started: TranslateStartPayload[]
  finish: (payload: TranslateDone) => Promise<void>
  fail: (requestId: string, failure: TranslationFailure) => Promise<void>
} {
  const started: TranslateStartPayload[] = []
  const done: Array<(payload: TranslateDone) => void> = []
  const failed: Array<(payload: { requestId: string; failure: TranslationFailure }) => void> = []
  const api = createApi({
    listRecentTranslations: () => Promise.resolve(options.rows ?? ROWS),
    listSavedSentences: () => Promise.resolve(options.sentences ?? []),
    startTranslation: (payload) => {
      started.push(payload)
      return Promise.resolve()
    },
    onDelta: () => () => undefined,
    onDone: (listener: (payload: TranslateDone) => void) => {
      done.push(listener)
      return () => undefined
    },
    onFailed: (listener: (payload: { requestId: string; failure: TranslationFailure }) => void) => {
      failed.push(listener)
      return () => undefined
    }
  })
  return {
    api,
    started,
    // Delivered through act, the way the panel's own stream arrives: a reply is a state update.
    finish: (payload) =>
      act(async () => {
        for (const listener of done) listener(payload)
      }),
    fail: (requestId, failure) =>
      act(async () => {
        for (const listener of failed) listener({ requestId, failure })
      })
  }
}

function setup(
  options: {
    enabled?: boolean
    api?: AssistantApi
    profile?: RecentFallback
  } = {}
): { onBack: ReturnType<typeof vi.fn>; onOpenLanguage: ReturnType<typeof vi.fn> } {
  window.api = options.api ?? createApi({ listRecentTranslations: () => Promise.resolve(ROWS) })
  const onBack = vi.fn()
  const onOpenLanguage = vi.fn()
  render(
    <RecentTranslationsPage
      floatingBall
      shortcut={SETTINGS.globalShortcut}
      enabled={options.enabled ?? true}
      profile={options.profile ?? PROFILE}
      onOpenLanguage={onOpenLanguage}
      onBack={onBack}
    />
  )
  return { onBack, onOpenLanguage }
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement
const learnButtons = (): HTMLButtonElement[] =>
  screen.queryAllByRole('button', { name: 'Learn' }) as HTMLButtonElement[]
const rows = (): HTMLElement[] => Array.from(document.querySelectorAll<HTMLElement>('.language__record'))

afterEach(() => {
  cleanup()
  delete window.api
})

describe('RecentTranslationsPage', () => {
  it('lists what was just translated, newest first, each row naming its own direction', async () => {
    setup()

    // The page keeps the store's order rather than sorting again: what is newest is the store's
    // business, and re-sorting here would only be a second opinion about the same timestamps.
    await waitFor(() => expect(rows()).toHaveLength(2))
    const first = rows()[0] as HTMLElement
    expect(first.querySelector('.recent__pair')?.textContent).toBe('Chinese → English')
    expect(first.textContent).toContain('I was going to go, but something came up.')
    const second = rows()[1] as HTMLElement
    expect(second.querySelector('.recent__pair')?.textContent).toBe('English → Chinese')
  })

  it('can read either line out loud, in the language that line is in', async () => {
    setup()

    await waitFor(() => expect(rows()).toHaveLength(2))
    const speakers = [...(rows()[0]?.querySelectorAll('.speak') ?? [])]
    // Unlike a lesson, there is no side here the user is assumed to know, so both lines speak,
    // and each one reads its own text rather than a shared language.
    expect(speakers.map((each) => each.getAttribute('aria-label'))).toEqual([
      '朗读：我本来想去，但是突然有事',
      '朗读：I was going to go, but something came up.'
    ])
  })

  it('says so when nothing has been translated yet', async () => {
    setup({ api: createApi() })

    expect(await screen.findByText(/还没有最近翻译/)).toBeDefined()
    expect(rows()).toHaveLength(0)
    expect(screen.queryByRole('button', { name: '清空全部' })).toBeNull()
  })

  it('explains itself and shows nothing while recording is off', async () => {
    setup({ enabled: false })

    expect(await screen.findByText(/最近翻译没有开启/)).toBeDefined()
    // Rows that were kept before the switch was turned off are not on this screen: the list is
    // off, and showing a stale list under an off switch would read as if it were still on.
    expect(rows()).toHaveLength(0)
  })

  it('empties the list in one press and reports what is left', async () => {
    const api = createApi({
      listRecentTranslations: () => Promise.resolve(ROWS),
      clearRecentTranslations: () => Promise.resolve([])
    })
    setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    await user.click(button('清空全部'))

    await waitFor(() => expect(rows()).toHaveLength(0))
    expect(screen.getByText(/还没有最近翻译/)).toBeDefined()
  })

  it('says why nothing could be read instead of looking empty', async () => {
    setup({
      api: createApi({ listRecentTranslations: () => Promise.reject(new Error('no bridge')) })
    })

    expect(await screen.findByText('无法读取最近翻译。')).toBeDefined()
  })

  it('goes back to the panel', async () => {
    const { onBack } = setup()
    const user = userEvent.setup()

    await user.click(button('返回'))

    expect(onBack).toHaveBeenCalledTimes(1)
  })
})

describe('RecentTranslationsPage: learning from a row that was never learned', () => {
  it('asks about the row itself: its own two texts, its own direction, its own register', async () => {
    const { api, started } = learnApi()
    setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    await user.click(learnButtons()[0] as HTMLButtonElement)

    await waitFor(() => expect(started).toHaveLength(1))
    const payload = started[0] as TranslateStartPayload
    expect(payload.task).toBe('analyze')
    // The relation comes off the row (Chinese native, English studied) even though the ask is
    // always the same way round: the moment travelled with its own direction.
    expect(payload.sourceLanguage).toBe('zh')
    expect(payload.targetLanguage).toBe('en')
    expect(payload.tone).toBe('casual')
    expect(payload.text).toBe('我本来想去，但是突然有事')
    expect(payload.result).toBe('I was going to go, but something came up.')
    expect(payload.sentence).toEqual({
      originalText: '我本来想去，但是突然有事',
      translatedText: 'I was going to go, but something came up.',
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    })
  })

  it('learns the row that was read, the other way round', async () => {
    const { api, started } = learnApi()
    setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    await user.click(learnButtons()[1] as HTMLButtonElement)

    await waitFor(() => expect(started).toHaveLength(1))
    const payload = started[0] as TranslateStartPayload
    // Read rather than written: what the user meant is the meaning that came back, and the
    // sentence being studied is the English they brought in.
    expect(payload.text).toBe('我本来打算加入你们。')
    expect(payload.result).toBe('I was going to join you.')
    expect(payload.sourceLanguage).toBe('zh')
    expect(payload.targetLanguage).toBe('en')
    expect(payload.sentence?.sourceLanguage).toBe('en')
    expect(payload.sentence?.targetLanguage).toBe('zh')
  })

  it('takes one row at a time: every Learn waits while one is being answered', async () => {
    const { api, started } = learnApi()
    setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    await user.click(learnButtons()[0] as HTMLButtonElement)

    await waitFor(() => expect(learnButtons().every((each) => each.disabled)).toBe(true))
    await user.click(learnButtons()[1] as HTMLButtonElement)
    expect(started).toHaveLength(1)
  })

  it('shows the note and the number it was filed under', async () => {
    const { api, started, finish } = learnApi()
    setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    await user.click(learnButtons()[0] as HTMLButtonElement)
    await waitFor(() => expect(started).toHaveLength(1))
    await finish({
      requestId: (started[0] as TranslateStartPayload).requestId,
      text: '',
      analysis: ANALYSIS,
      learned: SENTENCE,
      learnFailure: null
    })

    expect(await screen.findByText('come up')).toBeDefined()
    expect(await screen.findByText(/已学习 · #000001/)).toBeDefined()
    // The row keeps its receipt after the note is closed: it was filed, and that stays true.
    await user.click(button('收起 Learn 分析'))
    expect(screen.getByText(/已学习 · #000001/)).toBeDefined()
  })

  it('says why nothing was filed instead of showing a receipt', async () => {
    const { api, started, finish } = learnApi()
    setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    await user.click(learnButtons()[0] as HTMLButtonElement)
    await waitFor(() => expect(started).toHaveLength(1))
    await finish({
      requestId: (started[0] as TranslateStartPayload).requestId,
      text: '',
      analysis: ANALYSIS,
      learned: null,
      learnFailure: 'storage-failed'
    })

    expect(await screen.findByText(/学习记录没能写入/)).toBeDefined()
    // Nothing was filed, so the row still offers to try again.
    expect(learnButtons()).toHaveLength(2)
  })

  it('says why the request failed, and lets the row be asked again', async () => {
    const { api, started, fail } = learnApi()
    setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    await user.click(learnButtons()[0] as HTMLButtonElement)
    await waitFor(() => expect(started).toHaveLength(1))
    await fail((started[0] as TranslateStartPayload).requestId, {
      code: 'timeout',
      detail: 'request timed out'
    })

    expect(await screen.findByText('AI 服务响应超时，请重试。')).toBeDefined()
    // The answer never arrived, so the run is over and neither row is locked any more.
    expect(learnButtons().every((each) => !each.disabled)).toBe(true)
  })
})

describe('RecentTranslationsPage: rows that are already learned', () => {
  it('shows the number and opens the shelf it is kept on', async () => {
    const { api, started } = learnApi({ sentences: [SENTENCE] })
    const { onOpenLanguage } = setup({ api })
    const user = userEvent.setup()
    await waitFor(() => expect(rows()).toHaveLength(2))

    expect(await screen.findByText(/已学习 · #000001/)).toBeDefined()
    // Learn is not offered for it: it is already in My Learning, under that number.
    expect(learnButtons()).toHaveLength(1)

    await user.click(button('查看'))

    expect(onOpenLanguage).toHaveBeenCalledWith({ nativeLanguage: 'zh', learningLanguage: 'en' })
    expect(started).toHaveLength(0)
  })
})

describe('RecentTranslationsPage: rows that cannot be learned', () => {
  it('does not guess the studied language when the profile does not explain the row', async () => {
    setup({
      api: createApi({ listRecentTranslations: () => Promise.resolve([LEGACY]) }),
      // A row that never said which side it studied, opened under a profile whose learning
      // language is not one of its two sides: there is nothing to read, and a guess here would
      // coach the wrong language.
      profile: { nativeLanguage: 'zh', learningLanguage: 'fr' }
    })

    expect(await screen.findByText(/没有记下当时在学哪种语言/)).toBeDefined()
    expect(learnButtons()).toHaveLength(0)
  })

  it('still offers such a row when the profile does explain its direction', async () => {
    setup({ api: createApi({ listRecentTranslations: () => Promise.resolve([LEGACY]) }) })

    await waitFor(() => expect(rows()).toHaveLength(1))
    expect(learnButtons()).toHaveLength(1)
  })
})
