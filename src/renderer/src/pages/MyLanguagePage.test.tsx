// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgePoint, LearningKind, PublicSettings, SavedSentence } from '@shared/types'
import type { AssistantApi } from '@shared/types/api'
import { MyLanguagePage } from './MyLanguagePage'

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

function point(
  kind: LearningKind,
  expression: string,
  meaning: string,
  audioLanguage: KnowledgePoint['audioLanguage'],
  example = '',
  exampleTranslation = ''
): KnowledgePoint {
  return {
    id: 'p-' + expression,
    kind,
    expression,
    meaning,
    why: '',
    example,
    exampleTranslation,
    importance: 'medium',
    audioLanguage
  }
}

/** Two moments in Chinese -> English, and one in Chinese -> French. */
const SENTENCES: SavedSentence[] = [
  {
    id: 2,
    nativeLanguage: 'zh',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    originalText: '我本来想去，但是突然有事',
    translatedText: 'I was going to go, but something came up.',
    tone: 'natural',
    createdAt: '2026-09-25T10:00:00.000Z',
    savedAt: '2026-09-25T10:00:00.000Z',
    studyCount: 2,
    lastReviewedAt: '2026-09-25T10:00:00.000Z',
    masteryScore: 0,
    knowledgePoints: [
      point('pattern', 'I was going to', '我本来打算', 'en'),
      point(
        'expression',
        'something came up',
        '临时有事',
        'en',
        'Something came up, so I cannot make it tonight.',
        '临时有事，所以今晚我来不了。'
      )
    ]
  },
  {
    id: 1,
    nativeLanguage: 'zh',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    originalText: '我觉得这个想法挺有意思',
    translatedText: 'I think the idea is pretty interesting.',
    tone: 'casual',
    createdAt: '2026-09-20T10:00:00.000Z',
    savedAt: '2026-09-20T10:00:00.000Z',
    studyCount: 1,
    lastReviewedAt: '2026-09-20T10:00:00.000Z',
    masteryScore: 0,
    knowledgePoints: [point('vocabulary', 'pretty interesting', '挺有意思', 'en')]
  },
  {
    id: 1,
    nativeLanguage: 'zh',
    sourceLanguage: 'zh',
    targetLanguage: 'fr',
    learningLanguage: 'fr',
    originalText: '我本来想去',
    translatedText: 'J allais venir, mais quelque chose est arrive.',
    tone: 'natural',
    createdAt: '2026-09-18T10:00:00.000Z',
    savedAt: '2026-09-18T10:00:00.000Z',
    studyCount: 1,
    lastReviewedAt: '2026-09-18T10:00:00.000Z',
    masteryScore: 0,
    knowledgePoints: [point('expression', 'quelque chose est arrive', '临时有事', 'fr')]
  }
]

/** Only the My Learning calls matter here, but the whole bridge is stubbed for type safety. */
function createApi(overrides: Partial<AssistantApi>): AssistantApi {
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
    clearRecentTranslations: () => Promise.resolve([]),
    getBridgeStatus: () => Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    resetBridgeToken: () => Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    onBridgeStatus: () => () => undefined,
    onLearnSentence: () => () => undefined,
    openExtensionFolder: () => Promise.resolve({ ok: true, folder: null, message: '' }),
    exportLearning: () =>
      Promise.resolve({ ok: true, folder: 'D:/export', files: [], message: '' }),
    openDataFolder: () => Promise.resolve({ ok: true, folder: 'C:/data', message: '' })
  }
  return { ...stub, ...overrides }
}

function setup(api: AssistantApi): { onBack: ReturnType<typeof vi.fn> } {
  window.api = api
  const onBack = vi.fn()
  render(<MyLanguagePage floatingBall shortcut={SETTINGS.globalShortcut} onBack={onBack} />)
  return { onBack }
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name }) as HTMLButtonElement
const pairButton = (name: RegExp): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement

afterEach(() => {
  cleanup()
  delete window.api
})

describe('MyLanguagePage: the language pairs come first', () => {
  it('opens on the pairs the user has saved in, newest pair first', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))

    expect(await screen.findByText('Chinese → English')).toBeDefined()
    expect(screen.getByText('Chinese → French')).toBeDefined()
    // The count is what was kept, not how many times something was translated.
    expect(screen.getByText('2 saved')).toBeDefined()
    expect(screen.getByText('1 saved')).toBeDefined()
    // The pairs are the landing view; no sentence is shown until one is opened.
    expect(document.querySelectorAll('.language__record')).toHaveLength(0)
  })

  it('explains itself when nothing has been saved yet', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve([]) }))

    expect(await screen.findByText(/还没有学习记录/)).toBeDefined()
    expect(document.querySelectorAll('.language__pairs')).toHaveLength(0)
  })

  it('goes back to the panel without touching the store again', async () => {
    const listSavedSentences = vi.fn(() => Promise.resolve(SENTENCES))
    const { onBack } = setup(createApi({ listSavedSentences }))
    const user = userEvent.setup()
    await screen.findByText('Chinese → English')

    await user.click(button('返回'))

    expect(onBack).toHaveBeenCalledTimes(1)
    expect(listSavedSentences).toHaveBeenCalledTimes(1)
  })
})

describe('MyLanguagePage: one pair', () => {
  async function openPair(): Promise<ReturnType<typeof userEvent.setup>> {
    const user = userEvent.setup()
    await screen.findByText('Chinese → English')
    await user.click(pairButton(/Chinese → English/))
    return user
  }

  it('shows the sentence as it happened, under its id, newest first', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    await openPair()

    expect(document.querySelectorAll('.language__record')).toHaveLength(2)
    expect(screen.getByText('#000002')).toBeDefined()
    expect(screen.getByText('#000001')).toBeDefined()
    expect(screen.getByText('我本来想去，但是突然有事')).toBeDefined()
    expect(screen.getByText('I was going to go, but something came up.')).toBeDefined()
    // Only this pair: the French moment is not mixed in with it.
    expect(screen.queryByText('J allais venir, mais quelque chose est arrive.')).toBeNull()

    const ids = Array.from(document.querySelectorAll('.language__id')).map((node) => node.textContent)
    expect(ids).toEqual(['#000002', '#000001'])
  })

  it('says how much knowledge each sentence holds, and shows inside only when asked', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = await openPair()

    // Folded by default: each card names its count, and nothing inside shows yet.
    expect(screen.getByText('KNOWLEDGE · 2 points')).toBeDefined()
    expect(screen.getByText('KNOWLEDGE · 1 point')).toBeDefined()
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(0)
    expect(screen.queryByText('临时有事')).toBeNull()

    await user.click(screen.getAllByRole('button', { name: '展开知识点' })[0]!)

    // Opened: the sentence the user came back for, and the lesson inside it.
    expect(screen.getByText('something came up')).toBeDefined()
    expect(screen.getByText('临时有事')).toBeDefined()
    expect(screen.getByText('临时有事，所以今晚我来不了。')).toBeDefined()
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(2)
  })

  it('reads the studied sentence out in the language it was saved in', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = await openPair()

    // The English moment: its studied side is the translation, so that is what can be heard.
    expect(screen.getByLabelText('朗读：I was going to go, but something came up.')).toBeDefined()
    // The Chinese is the language the user already speaks, so it is not spoken.
    expect(screen.queryByLabelText('朗读：我本来想去，但是突然有事')).toBeNull()

    // A point's own line is on the page, and so hearable, only once the card is opened.
    await user.click(screen.getAllByRole('button', { name: '展开知识点' })[0]!)
    expect(screen.getByLabelText('朗读：something came up')).toBeDefined()
  })

  it('lets a long sentence be opened up without hiding anything for good', async () => {
    const long: SavedSentence = {
      ...SENTENCES[0]!,
      id: 9,
      knowledgePoints: Array.from({ length: 5 }, (_value, index) =>
        point('expression', 'point ' + String(index), '意思 ' + String(index), 'en')
      )
    }
    setup(createApi({ listSavedSentences: () => Promise.resolve([long]) }))
    const user = await openPair()

    // Nothing inside until asked for, however many points there are.
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(0)
    expect(screen.getByText('KNOWLEDGE · 5 points')).toBeDefined()

    await user.click(button('展开知识点'))
    // No cap: all five show at once.
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(5)

    await user.click(button('收起知识点'))
    expect(document.querySelectorAll('.analysis__item')).toHaveLength(0)
    expect(screen.getByText('KNOWLEDGE · 5 points')).toBeDefined()
  })

  it('keeps Expressions and Vocabulary as views of this pair\u2019s sentences', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = await openPair()

    await user.click(button('Expressions'))
    expect(screen.getByText('= 临时有事')).toBeDefined()
    // A pattern is not an expression, so it stays where it belongs: in the sentence.
    expect(screen.queryByText('= 我本来打算')).toBeNull()
    // A view, not a second collection: the sentence is not repeated under it.
    expect(document.querySelectorAll('.language__record')).toHaveLength(0)
    // And every line still says which sentence it came from.
    expect(screen.getAllByText('#000002').length).toBeGreaterThan(0)

    await user.click(button('Vocabulary'))
    expect(screen.getByText('= 挺有意思')).toBeDefined()
    expect(screen.queryByText('= 临时有事')).toBeNull()

    await user.click(button('Sentences'))
    expect(document.querySelectorAll('.language__record')).toHaveLength(2)
  })

  it('goes back to the pair list', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = await openPair()

    await user.click(button('← My Learning'))

    expect(screen.getByText('Chinese → French')).toBeDefined()
    expect(document.querySelectorAll('.language__record')).toHaveLength(0)
  })

  it('deletes one sentence for good, naming both halves of its id', async () => {
    const removeSentence = vi.fn(() => Promise.resolve([SENTENCES[1]!, SENTENCES[2]!]))
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES), removeSentence }))
    const user = await openPair()

    await user.click(button('删除句子 #000002'))

    expect(removeSentence).toHaveBeenCalledWith({ nativeLanguage: 'zh', learningLanguage: 'en', id: 2 })
    await waitFor(() => expect(document.querySelectorAll('.language__record')).toHaveLength(1))
    expect(screen.queryByText('#000002')).toBeNull()
  })

  it('closes the pair when its last sentence is deleted', async () => {
    setup(
      createApi({
        listSavedSentences: () => Promise.resolve([SENTENCES[1]!]),
        removeSentence: () => Promise.resolve([])
      })
    )
    const user = await openPair()

    await user.click(button('删除句子 #000001'))

    // Nothing left at all, so the page falls back to saying so rather than to an empty pair.
    await waitFor(() => expect(screen.getByText(/还没有学习记录/)).toBeDefined())
    expect(document.querySelectorAll('.language__record')).toHaveLength(0)
  })

  it('clears everything when asked', async () => {
    const clearSentences = vi.fn(() => Promise.resolve([]))
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES), clearSentences }))
    const user = userEvent.setup()
    await screen.findByText('Chinese → English')

    await user.click(button('清空全部'))

    expect(clearSentences).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(document.querySelectorAll('.language__pairs')).toHaveLength(0))
    expect(screen.getByText(/还没有学习记录/)).toBeDefined()
  })
})

describe('MyLanguagePage: search', () => {
  it('finds a sentence by a point inside it, and answers with the whole sentence', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = userEvent.setup()
    await screen.findByText('Chinese → English')

    await user.type(screen.getByLabelText('搜索 My Learning'), 'something came up')

    // The hit is the moment, not a floating word: original, translation and its points.
    expect(screen.getByText('我本来想去，但是突然有事')).toBeDefined()
    expect(screen.getByText('I was going to go, but something came up.')).toBeDefined()
    expect(screen.getByText('#000002')).toBeDefined()
    expect(screen.queryByText('#000001')).toBeNull()
  })

  it('looks through every pair at once, and says which pair a hit came from', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = userEvent.setup()
    await screen.findByText('Chinese → English')

    // Both moments mean the same thing; only one of them is in the pair the user is studying.
    await user.type(screen.getByLabelText('搜索 My Learning'), '临时有事')

    expect(screen.getByText('I was going to go, but something came up.')).toBeDefined()
    expect(screen.getByText('J allais venir, mais quelque chose est arrive.')).toBeDefined()
    expect(screen.getAllByText('Chinese → English').length).toBeGreaterThan(0)
    expect(screen.getAllByText('Chinese → French').length).toBeGreaterThan(0)
  })

  it('says so when nothing matches', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = userEvent.setup()
    await screen.findByText('Chinese → English')

    await user.type(screen.getByLabelText('搜索 My Learning'), 'zzz')

    expect(screen.getByText(/没有找到/)).toBeDefined()
    expect(document.querySelectorAll('.language__record')).toHaveLength(0)
  })

  it('leaves the pairs alone once a pair is open', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    const user = userEvent.setup()
    await screen.findByText('Chinese → English')
    await user.click(pairButton(/Chinese → English/))

    // Inside a pair the search box is out of the way: v1 searches at the top level only.
    expect(screen.queryByLabelText('搜索 My Learning')).toBeNull()
  })
})

describe('MyLanguagePage: what it is not', () => {
  it('reads as what the user kept, not as a history of what they translated', async () => {
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) }))
    await screen.findByText('Chinese → English')

    expect(document.body.textContent).not.toMatch(/翻译过|今天|统计|streak|points earned/i)
  })
})

describe('MyLanguagePage: arriving from somewhere else', () => {
  it('opens straight onto the shelf it was asked for', async () => {
    window.api = createApi({ listSavedSentences: () => Promise.resolve(SENTENCES) })
    render(
      <MyLanguagePage
        floatingBall
        shortcut={SETTINGS.globalShortcut}
        focusPair={{ nativeLanguage: 'zh', learningLanguage: 'fr' }}
        onBack={vi.fn()}
      />
    )

    // The pair list is skipped: the user came for one sentence, and this is the shelf it is on.
    expect(await screen.findByText('J allais venir, mais quelque chose est arrive.')).toBeDefined()
    expect(document.querySelectorAll('.language__pairs')).toHaveLength(0)
    // Only that shelf: the English moments are on another one.
    expect(screen.queryByText('I think the idea is pretty interesting.')).toBeNull()
  })
})

describe('MyLanguagePage: taking the library out as a document', () => {
  it('exports and says where the files went', async () => {
    const user = userEvent.setup()
    const exportLearning = vi.fn(() =>
      Promise.resolve({
        ok: true,
        folder: 'D:/Documents/ctoe 学习记录',
        files: ['D:/Documents/ctoe 学习记录/Chinese_English.docx'],
        message: ''
      })
    )
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES), exportLearning }))

    // The actions belong to the loaded library, so the list has to be there first.
    await screen.findByText('Chinese → English')
    await user.click(button('导出为 Word'))

    expect(exportLearning).toHaveBeenCalledTimes(1)
    // The files land outside the app, so the page is the only place that can say where.
    expect(
      await screen.findByText('已导出 1 个文件到 D:/Documents/ctoe 学习记录')
    ).toBeDefined()
  })

  it('repeats what the main process said when nothing was written', async () => {
    const user = userEvent.setup()
    const exportLearning = vi.fn(() =>
      Promise.resolve({
        ok: false,
        folder: null,
        files: [],
        message: '还没有学习记录，先点一次 Learn。'
      })
    )
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES), exportLearning }))

    await screen.findByText('Chinese → English')
    await user.click(button('导出为 Word'))

    expect(await screen.findByText('还没有学习记录，先点一次 Learn。')).toBeDefined()
  })

  it('opens the folder the records live in', async () => {
    const user = userEvent.setup()
    const openDataFolder = vi.fn(() => Promise.resolve({ ok: true, folder: 'C:/data', message: '' }))
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES), openDataFolder }))

    await screen.findByText('Chinese → English')
    await user.click(button('打开数据文件夹'))

    expect(openDataFolder).toHaveBeenCalledTimes(1)
  })

  it('says when the folder could not be opened instead of doing nothing', async () => {
    const user = userEvent.setup()
    const openDataFolder = vi.fn(() =>
      Promise.resolve({ ok: false, folder: 'C:/data', message: 'no file manager' })
    )
    setup(createApi({ listSavedSentences: () => Promise.resolve(SENTENCES), openDataFolder }))

    await screen.findByText('Chinese → English')
    await user.click(button('打开数据文件夹'))

    expect(await screen.findByText('no file manager')).toBeDefined()
  })
})
