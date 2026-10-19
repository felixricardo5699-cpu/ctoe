import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_INPUT_CHARS } from '@shared/config/defaults'
import { knowledgePointKey } from '@shared/language/items'
import { nativeLanguageOf } from '@shared/language/pair'
import { sameSentenceIdentity } from '@shared/language/records'
import { SentenceIdExhaustedError } from '@shared/language/sentenceId'
import type { LanguageCode } from '@shared/language/registry'
import { parseLearningAnalysis, parseUnderstanding } from '@shared/learning/parse'
import {
  KNOWLEDGE_POINT_SAFETY_LIMIT,
  type BrowserBridgePolicy,
  type KnowledgePoint,
  type LearningItem,
  type ProviderSettings,
  type PublicSettings,
  type RecentPolicy,
  type RecentTranslation,
  type SavedSentence,
  type SavedSentenceDraft,
  type SavedSentenceRef,
  type SettingsPatch,
  type ShortcutStatus
} from '@shared/types'
import type { BridgeStatus } from '@shared/types/bridge'
import type { ExportDocument } from '@shared/learning/exportDocument'
import {
  IPC,
  type DataFolderResult,
  type ExtensionFolderResult,
  type LearningExportResult,
  type TranslateDelta,
  type TranslateDone,
  type TranslateFailed,
  type TranslateStartPayload
} from '@shared/types/ipc'
import { MOCK_ANALYSIS, MOCK_OUTPUT, MOCK_UNDERSTANDING } from '../services/ai/MockProvider'
import type { ConfigStore } from '../services/config/configStore'
import type { LanguageStore } from '../services/language/languageStore'
import type { RecentStore, RecentTranslationDraft } from '../services/recent/recentStore'
import {
  registerIpcHandlers,
  type BridgeController,
  type FilesController,
  type ShortcutController,
  type WindowController
} from './handlers'

/*
 * The IPC layer, driven without Electron.
 *
 * Every test here talks to the same surface the preload bridge does: it invokes a channel and
 * reads what came back, or watches the messages main pushes at the renderer. The stores and the
 * window are stand-ins, because what is being pinned down is the wiring rather than the disk -
 * which sentence got filed, under which relation, what the renderer was told, and what was
 * deliberately dropped.
 */

/** Captured by the electron stand-in below, which is hoisted above the imports. */
const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => unknown>(),
  clipboard: '',
  quits: 0
}))

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.1.0-test',
    getPath: (name: string) => 'test-user-data/' + name,
    setPath: () => undefined,
    isPackaged: false,
    quit: () => {
      state.quits += 1
    },
    setLoginItemSettings: () => undefined
  },
  ipcMain: {
    handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown): void => {
      state.handlers.set(channel, listener)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => {
      throw new Error('no keyring in this environment')
    },
    decryptString: () => {
      throw new Error('no keyring in this environment')
    }
  },
  clipboard: {
    writeText: (text: string) => {
      state.clipboard = text
      return Promise.resolve()
    },
    readText: () => Promise.resolve(state.clipboard)
  }
}))

/**
 * The canned answers as they really are, streamed without the demo pause: what these tests are
 * about is the chunk-by-chunk behaviour, not the 25ms between two chunks.
 */
vi.mock('../services/ai/MockProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/ai/MockProvider')>()
  class FastMockProvider extends actual.MockProvider {
    constructor() {
      super(0)
    }
  }
  return { ...actual, MockProvider: FastMockProvider }
})

/** What the panel would have in its two boxes when it asks for a note. */
const EXPRESSION = '我觉得这话有点太绝对了'
const STUDIED = 'I think that is a bit too absolute.'
const READ_SENTENCE = 'I was going to join you, but something came up.'
const UNDERSTANDING_MEANING = parseUnderstanding(MOCK_UNDERSTANDING)?.meaning ?? ''

const ANALYSIS_ITEMS = parseLearningAnalysis(MOCK_ANALYSIS)?.items ?? []
const UNDERSTANDING_ITEMS = parseUnderstanding(MOCK_UNDERSTANDING)?.items ?? []

/** One sentence as the store would hand it back, for the reads that only pass it through. */
const FILED: SavedSentence = {
  id: 1,
  nativeLanguage: 'zh',
  learningLanguage: 'en',
  sourceLanguage: 'zh',
  targetLanguage: 'en',
  originalText: EXPRESSION,
  translatedText: STUDIED,
  tone: 'natural',
  createdAt: '2026-09-24T10:00:00.000Z',
  savedAt: '2026-09-24T10:00:00.000Z',
  studyCount: 1,
  lastReviewedAt: '2026-09-24T10:00:00.000Z',
  masteryScore: 0,
  knowledgePoints: []
}

interface SentMessage {
  channel: string
  payload: unknown
}

interface HarnessOptions {
  kind?: PublicSettings['providerKind']
  /** null means no key has ever been stored, which is not the same as an empty one. */
  apiKey?: string | null
  floatingBall?: boolean
  recentPolicy?: RecentPolicy
  bridgePolicy?: BrowserBridgePolicy
  nativeLanguage?: LanguageCode
  learningLanguage?: LanguageCode
  /** undefined means this build ships one; null means it does not. */
  extensionFolder?: string | null
  /** Non-empty means the file manager refused to open it. */
  revealFailure?: string
}

interface FakeConfig {
  path: string
  lastPatch: SettingsPatch | null
  updates: number
  token: string
  readPublicSettings(): PublicSettings
  readProviderSettings(): ProviderSettings | null
  updateSettings(patch: SettingsPatch): PublicSettings
  readBridgeToken(): string
  writeBridgeToken(token: string): void
}

interface FakeWindows {
  controller: WindowController
  calls: string[]
  ballEnabled: boolean
  /** main -> renderer messages the window would have received. */
  pushed: SentMessage[]
}

interface FakeShortcuts {
  controller: ShortcutController
  applied: string[]
  accelerator: string
}

interface FakeBridge {
  controller: BridgeController
  applied: number
  resets: number
  token: string
  /** When set, applyPolicy refuses the way a machine with every port taken does. */
  failApply: boolean
}

interface FakeLanguage {
  store: LanguageStore
  records: SavedSentence[]
  /** Every draft the panel asked to keep, in order. */
  saved: SavedSentenceDraft[]
  /** Every draft Learn asked to study, in order. */
  learnt: SavedSentenceDraft[]
  nextId: number
  failSave: 'exhausted' | 'disk' | null
  failLearn: 'exhausted' | 'disk' | null
}

interface FakeRecent {
  store: RecentStore
  rows: RecentTranslation[]
  drafts: RecentTranslationDraft[]
  failRecord: boolean
}

/**
 * The OS-facing side of exporting: a folder picker, a file manager and a place to put files. Every
 * answer is recorded, because "did the user get asked", "was the file revealed" and "did we claim
 * success anyway" are the parts of this feature a test can actually hold on to.
 */
interface FakeFiles {
  controller: FilesController
  /** Default folders the picker was opened in. */
  asked: string[]
  /** What the picker answers; null means the user cancelled. */
  chosen: string | null
  /** Every batch of documents handed to the writer. */
  written: ExportDocument[][]
  revealed: string[]
  opened: string[]
  dataFolder: string
  exportFolder: string
  /** When set, writing fails with this message. */
  failWrite: string | null
  /** When set, opening a folder answers with this instead of ''. */
  openFailure: string
}

interface Harness {
  settings: PublicSettings
  config: FakeConfig
  windows: FakeWindows
  shortcuts: FakeShortcuts
  language: FakeLanguage
  recent: FakeRecent
  bridge: FakeBridge
  files: FakeFiles
  sent: SentMessage[]
  invoke(channel: string, payload?: unknown): Promise<unknown>
  cancelAll(): void
}

/** The one place the stand-in writes, doing what the real store does with a draft. */
function fileDraft(language: FakeLanguage, draft: SavedSentenceDraft, studied: boolean): SavedSentence {
  const nativeLanguage = nativeLanguageOf(draft, 'zh')
  const existing = language.records.find((record) =>
    sameSentenceIdentity(record, { ...draft, nativeLanguage })
  )
  const now = '2026-09-24T10:00:00.000Z'
  if (existing !== undefined) {
    existing.originalText = draft.originalText
    existing.translatedText = draft.translatedText
    existing.savedAt = now
    existing.knowledgePoints = mergePoints(
      existing.knowledgePoints,
      draft.knowledgePoints,
      draft.learningLanguage
    )
    if (studied) {
      existing.studyCount += 1
      existing.lastReviewedAt = now
    }
    return existing
  }
  const record: SavedSentence = {
    id: language.nextId,
    nativeLanguage,
    sourceLanguage: draft.sourceLanguage,
    targetLanguage: draft.targetLanguage,
    learningLanguage: draft.learningLanguage,
    originalText: draft.originalText,
    translatedText: draft.translatedText,
    tone: draft.tone,
    createdAt: now,
    savedAt: now,
    studyCount: studied ? 1 : 0,
    lastReviewedAt: studied ? now : null,
    masteryScore: 0,
    knowledgePoints: mergePoints([], draft.knowledgePoints, draft.learningLanguage)
  }
  language.nextId += 1
  language.records.unshift(record)
  return record
}

/** What was already kept plus every point of this answer that is not already there. */
function mergePoints(
  kept: readonly KnowledgePoint[],
  items: readonly LearningItem[],
  learningLanguage: LanguageCode
): KnowledgePoint[] {
  const points = [...kept]
  const seen = new Set(points.map((point) => knowledgePointKey(point)))
  for (const item of items) {
    const point: KnowledgePoint = {
      id: 'point-' + String(points.length),
      kind: item.kind,
      expression: item.expression,
      meaning: item.meaning,
      why: item.why,
      example: item.example,
      exampleTranslation: item.exampleTranslation,
      importance: item.importance ?? 'medium',
      audioLanguage: learningLanguage
    }
    const key = knowledgePointKey(point)
    if (seen.has(key)) continue
    seen.add(key)
    points.push(point)
  }
  return points
}

function createHarness(options: HarnessOptions = {}): Harness {
  const settings: PublicSettings = {
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    tone: 'natural',
    providerKind: options.kind ?? 'mock',
    nativeLanguage: options.nativeLanguage ?? 'zh',
    learningLanguage: options.learningLanguage ?? 'en',
    hasApiKey: (options.apiKey ?? null) !== null,
    apiKeyEncrypted: false,
    floatingBall: options.floatingBall ?? true,
    globalShortcut: 'CommandOrControl+Shift+Space',
    launchAtLogin: false,
    recentPolicy: options.recentPolicy ?? 'off',
    browserBridgePolicy: options.bridgePolicy ?? 'off'
  }

  const config: FakeConfig = {
    path: 'test-config.json',
    lastPatch: null,
    updates: 0,
    token: 'token-for-tests',
    readPublicSettings: () => ({ ...settings }),
    readProviderSettings: () =>
      settings.hasApiKey
        ? { baseUrl: settings.baseUrl, model: settings.model, apiKey: 'sk-test' }
        : null,
    updateSettings: (patch) => {
      config.lastPatch = patch
      config.updates += 1
      Object.assign(settings, patch)
      return { ...settings }
    },
    readBridgeToken: () => config.token,
    writeBridgeToken: (next) => {
      config.token = next
    }
  }

  const sent: SentMessage[] = []

  const windows: FakeWindows = {
    controller: null as unknown as WindowController,
    calls: [],
    ballEnabled: settings.floatingBall,
    pushed: []
  }
  windows.controller = {
    expand: () => {
      windows.calls.push('expand')
    },
    collapse: () => {
      windows.calls.push('collapse')
    },
    hide: () => {
      windows.calls.push('hide')
    },
    toggle: () => {
      windows.calls.push('toggle')
    },
    startDrag: () => {
      windows.calls.push('drag-start')
    },
    endDrag: () => {
      windows.calls.push('drag-end')
    },
    setFloatingBall: (enabled: boolean) => {
      windows.ballEnabled = enabled
      windows.calls.push('ball:' + String(enabled))
    },
    windowMode: () => ({ mode: 'panel', anchor: 'below' }),
    send: (channel: string, payload: unknown) => {
      windows.pushed.push({ channel, payload })
    }
  }

  const shortcuts: FakeShortcuts = {
    controller: null as unknown as ShortcutController,
    applied: [],
    accelerator: settings.globalShortcut
  }
  shortcuts.controller = {
    status: (): ShortcutStatus => ({ ok: true, accelerator: shortcuts.accelerator, message: '' }),
    set: (next: string): ShortcutStatus => {
      shortcuts.accelerator = next
      shortcuts.applied.push(next)
      return { ok: true, accelerator: next, message: '' }
    }
  }

  const bridge: FakeBridge = {
    controller: null as unknown as BridgeController,
    applied: 0,
    resets: 0,
    token: 'token-for-tests',
    failApply: false
  }
  const bridgeStatus = (): BridgeStatus => ({
    policy: settings.browserBridgePolicy,
    listening: false,
    port: null,
    token: bridge.token,
    lastRequestAt: null
  })
  bridge.controller = {
    status: bridgeStatus,
    resetToken: () => {
      bridge.resets += 1
      bridge.token = 'reset-token-for-tests'
      return bridgeStatus()
    },
    applyPolicy: async () => {
      bridge.applied += 1
      // The real service refuses when every port in its range is already taken.
      if (bridge.failApply) throw new Error('no free bridge port')
    }
  }

  const language: FakeLanguage = {
    store: null as unknown as LanguageStore,
    records: [],
    saved: [],
    learnt: [],
    nextId: 1,
    failSave: null,
    failLearn: null
  }
  language.store = {
    path: 'test-learned.json',
    list: () => [...language.records],
    save: (draft: SavedSentenceDraft) => {
      if (language.failSave === 'exhausted') throw new SentenceIdExhaustedError(0x1000000)
      if (language.failSave === 'disk') throw new Error('the file could not be written')
      language.saved.push(draft)
      fileDraft(language, draft, false)
      return [...language.records]
    },
    learn: (draft: SavedSentenceDraft) => {
      if (language.failLearn === 'exhausted') throw new SentenceIdExhaustedError(0x1000000)
      if (language.failLearn === 'disk') throw new Error('the file could not be written')
      language.learnt.push(draft)
      return fileDraft(language, draft, true)
    },
    remove: (ref: SavedSentenceRef) => {
      language.records = language.records.filter((record) => record.id !== ref.id)
      return [...language.records]
    },
    clear: () => {
      language.records = []
      return []
    }
  } as unknown as LanguageStore

  const recent: FakeRecent = {
    store: null as unknown as RecentStore,
    rows: [],
    drafts: [],
    failRecord: false
  }
  recent.store = {
    path: 'test-recent.json',
    list: () => [...recent.rows],
    record: (draft: RecentTranslationDraft) => {
      if (recent.failRecord) throw new Error('the list could not be written')
      recent.drafts.push(draft)
      const row: RecentTranslation = {
        id: 'row-' + String(recent.rows.length + 1),
        sourceLanguage: draft.sourceLanguage,
        targetLanguage: draft.targetLanguage,
        learningLanguage: draft.learningLanguage,
        tone: draft.tone,
        sourceText: draft.sourceText,
        targetText: draft.targetText,
        createdAt: '2026-09-24T10:00:00.000Z'
      }
      recent.rows = [row, ...recent.rows]
      return [...recent.rows]
    },
    clear: () => {
      recent.rows = []
      return []
    }
  } as unknown as RecentStore

  const event = {
    sender: {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload })
      }
    }
  }

  const files: FakeFiles = {
    controller: null as unknown as FilesController,
    asked: [],
    chosen: 'D:/export',
    written: [],
    revealed: [],
    opened: [],
    dataFolder: 'C:/Users/me/AppData/Roaming/ctoe',
    exportFolder: 'C:/Users/me/Documents/ctoe 学习记录',
    failWrite: null,
    openFailure: ''
  }
  files.controller = {
    dataFolder: () => files.dataFolder,
    exportFolder: () => files.exportFolder,
    openFolder: (folder: string) => {
      files.opened.push(folder)
      return Promise.resolve(files.openFailure)
    },
    chooseFolder: (folder: string) => {
      files.asked.push(folder)
      return Promise.resolve(files.chosen)
    },
    writeDocuments: (folder: string, documents: readonly ExportDocument[]) => {
      if (files.failWrite !== null) return Promise.reject(new Error(files.failWrite))
      files.written.push([...documents])
      return Promise.resolve(documents.map((document) => folder + '/' + document.fileName))
    },
    revealFile: (file: string) => {
      files.revealed.push(file)
    }
  }

  const handlers = registerIpcHandlers({
    config: config as unknown as ConfigStore,
    windows: windows.controller,
    shortcuts: shortcuts.controller,
    language: language.store,
    recent: recent.store,
    bridge: bridge.controller,
    extension: {
      folder: () => (options.extensionFolder === undefined ? 'C:/tmp/extension' : options.extensionFolder),
      reveal: () => Promise.resolve(options.revealFailure ?? '')
    },
    files: files.controller
  })

  return {
    settings,
    config,
    windows,
    shortcuts,
    language,
    recent,
    bridge,
    files,
    sent,
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      const handler = state.handlers.get(channel)
      if (handler === undefined) return Promise.reject(new Error('no handler for ' + channel))
      // Electron answers an invoke with a promise, and a listener that throws rejects it.
      return Promise.resolve().then(() => handler(event, payload))
    },
    cancelAll: handlers.cancelAll
  }
}

function deltas(harness: Harness): TranslateDelta[] {
  return harness.sent
    .filter((message) => message.channel === IPC.translateDelta)
    .map((message) => message.payload as TranslateDelta)
}

function lastDone(harness: Harness): TranslateDone {
  const messages = harness.sent.filter((message) => message.channel === IPC.translateDone)
  const final = messages[messages.length - 1]
  if (final === undefined) throw new Error('the run never finished')
  return final.payload as TranslateDone
}

function failures(harness: Harness): TranslateFailed[] {
  return harness.sent
    .filter((message) => message.channel === IPC.translateFailed)
    .map((message) => message.payload as TranslateFailed)
}

function lastFailure(harness: Harness): TranslateFailed {
  const seen = failures(harness)
  const final = seen[seen.length - 1]
  if (final === undefined) throw new Error('the run did not fail')
  return final
}

/** Lets the queued handlers reach the stores before the test acts on what they did. */
async function flush(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve()
}

/** The request the panel sends when the user asks Learn about what is on screen. */
function analyzePayload(overrides: Partial<TranslateStartPayload> = {}): TranslateStartPayload {
  return {
    requestId: 'learn-1',
    text: EXPRESSION,
    tone: 'natural',
    context: '',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    task: 'analyze',
    result: STUDIED,
    sentence: {
      originalText: EXPRESSION,
      translatedText: STUDIED,
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    },
    ...overrides
  }
}

beforeEach(() => {
  state.handlers.clear()
  state.clipboard = ''
  state.quits = 0
})

describe('ipc handlers', () => {
  it('registers exactly the channels the preload bridge invokes', () => {
    createHarness()

    expect([...state.handlers.keys()].sort()).toEqual(
      [
        IPC.settingsGet,
        IPC.settingsSet,
        IPC.appInfo,
        IPC.clipboardWrite,
        IPC.clipboardRead,
        IPC.translateStart,
        IPC.translateCancel,
        IPC.windowExpand,
        IPC.windowCollapse,
        IPC.windowToggle,
        IPC.windowHide,
        IPC.windowQuit,
        IPC.windowGetMode,
        IPC.windowDragStart,
        IPC.windowDragEnd,
        IPC.shortcutGet,
        IPC.shortcutSet,
        IPC.languageList,
        IPC.languageSave,
        IPC.languageRemove,
        IPC.languageClear,
        IPC.recentList,
        IPC.recentClear,
        IPC.bridgeStatus,
        IPC.bridgeResetToken,
        IPC.extensionOpenFolder,
        IPC.languageExport,
        IPC.dataOpenFolder
      ].sort()
    )
  })

  it('answers the settings read with what the store holds', async () => {
    const harness = createHarness()

    const settings = (await harness.invoke(IPC.settingsGet)) as PublicSettings

    expect(settings.providerKind).toBe('mock')
    expect(settings.nativeLanguage).toBe('zh')
    expect(settings.learningLanguage).toBe('en')
  })

  it('applies a settings patch and answers with the settings it now holds', async () => {
    const harness = createHarness()

    const after = (await harness.invoke(IPC.settingsSet, {
      tone: 'casual',
      model: 'other-model'
    })) as PublicSettings

    expect(harness.config.lastPatch).toEqual({ tone: 'casual', model: 'other-model' })
    expect(after.tone).toBe('casual')
    expect(after.model).toBe('other-model')
  })

  it('drops a value the settings do not understand and keeps the rest of the patch', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.settingsSet, { tone: 'shouty', model: 'other-model' })

    expect(harness.config.lastPatch).toEqual({ model: 'other-model' })
  })

  it('grows the floating ball in or out as the setting moves', async () => {
    const harness = createHarness({ floatingBall: true })

    await harness.invoke(IPC.settingsSet, { floatingBall: false })

    expect(harness.windows.calls).toEqual(['ball:false'])
  })

  it('answers the app info with the version and the config path', async () => {
    const harness = createHarness()

    expect(await harness.invoke(IPC.appInfo)).toEqual({
      version: '0.1.0-test',
      platform: process.platform,
      configPath: 'test-config.json'
    })
  })

  it('copies what the renderer asks it to copy, and refuses to copy nothing', async () => {
    const harness = createHarness()

    expect(await harness.invoke(IPC.clipboardWrite, '你好')).toBe(true)
    expect(state.clipboard).toBe('你好')
    expect(await harness.invoke(IPC.clipboardWrite, '')).toBe(false)
  })

  it('reads the clipboard back for the input box', async () => {
    const harness = createHarness()
    state.clipboard = 'pasted from somewhere else'

    expect(await harness.invoke(IPC.clipboardRead)).toBe('pasted from somewhere else')
  })

  it('drives the window shape on request', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.windowExpand)
    await harness.invoke(IPC.windowCollapse)
    await harness.invoke(IPC.windowToggle)
    await harness.invoke(IPC.windowHide)

    expect(harness.windows.calls).toEqual(['expand', 'collapse', 'toggle', 'hide'])
  })

  it('quits the app when the renderer asks it to', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.windowQuit)

    expect(state.quits).toBe(1)
  })

  it('answers the window shape the renderer asks for on mount', async () => {
    const harness = createHarness()

    expect(await harness.invoke(IPC.windowGetMode)).toEqual({ mode: 'panel', anchor: 'below' })
  })

  it('starts and ends a ball drag', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.windowDragStart)
    await harness.invoke(IPC.windowDragEnd)

    expect(harness.windows.calls).toEqual(['drag-start', 'drag-end'])
  })

  it('reports the shortcut and applies a new one', async () => {
    const harness = createHarness()

    const before = (await harness.invoke(IPC.shortcutGet)) as ShortcutStatus
    const after = (await harness.invoke(IPC.shortcutSet, 'Control+Shift+E')) as ShortcutStatus

    expect(before.accelerator).toBe('CommandOrControl+Shift+Space')
    expect(after.accelerator).toBe('Control+Shift+E')
    expect(harness.shortcuts.applied).toEqual(['Control+Shift+E'])
  })

  it('treats a shortcut that is not a string as an empty one', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.shortcutSet, 42)

    expect(harness.shortcuts.applied).toEqual([''])
  })

  it('lists what My Learning holds', async () => {
    const harness = createHarness()
    harness.language.records.push(FILED)

    expect(await harness.invoke(IPC.languageList)).toEqual([FILED])
  })

  it('files a sentence draft the store accepts', async () => {
    const harness = createHarness()

    const list = (await harness.invoke(IPC.languageSave, {
      originalText: '你好',
      translatedText: 'Hello',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      learningLanguage: 'en',
      tone: 'natural',
      knowledgePoints: []
    })) as SavedSentence[]

    expect(harness.language.saved).toHaveLength(1)
    expect(list).toHaveLength(1)
    expect(list[0]?.originalText).toBe('你好')
    expect(list[0]?.learningLanguage).toBe('en')
  })

  it('drops a draft that carries no text at all', async () => {
    const harness = createHarness()

    const list = (await harness.invoke(IPC.languageSave, {
      originalText: '   ',
      translatedText: '',
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    })) as SavedSentence[]

    expect(list).toEqual([])
    expect(harness.language.saved).toHaveLength(0)
  })

  it('drops a draft whose two languages are the same', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.languageSave, {
      originalText: '你好',
      translatedText: 'Hello',
      sourceLanguage: 'zh',
      targetLanguage: 'zh'
    })

    expect(harness.language.saved).toHaveLength(0)
  })

  it('keeps only the points it can read, and never more than the safety ceiling', async () => {
    const harness = createHarness()
    const points = Array.from({ length: KNOWLEDGE_POINT_SAFETY_LIMIT + 6 }, (_unused, index) => ({
      kind: 'expression',
      expression: 'point ' + String(index),
      meaning: '意思 ' + String(index),
      why: '',
      example: '',
      exampleTranslation: ''
    }))
    points.push({
      kind: 'nonsense',
      expression: 'unreadable',
      meaning: '',
      why: '',
      example: '',
      exampleTranslation: ''
    })

    await harness.invoke(IPC.languageSave, {
      originalText: '你好',
      translatedText: 'Hello',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      learningLanguage: 'en',
      knowledgePoints: points
    })

    const filed = harness.language.saved[0]
    expect(filed?.knowledgePoints).toHaveLength(KNOWLEDGE_POINT_SAFETY_LIMIT)
    expect(filed?.knowledgePoints[0]).toMatchObject({
      kind: 'expression',
      expression: 'point 0',
      meaning: '意思 0'
    })
  })

  it('gives a point the model did not label a readable kind instead of dropping it', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.languageSave, {
      originalText: '你好',
      translatedText: 'Hello',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      learningLanguage: 'en',
      knowledgePoints: [
        { kind: 'nonsense', expression: '嗯', meaning: 'hm', why: '', example: '', exampleTranslation: '' }
      ]
    })

    expect(harness.language.saved[0]?.knowledgePoints[0]?.kind).toBe('expression')
  })

  it('cuts an over-long field rather than throwing the point away', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.languageSave, {
      originalText: '你好',
      translatedText: 'Hello',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      learningLanguage: 'en',
      knowledgePoints: [
        {
          kind: 'expression',
          expression: 'x'.repeat(400),
          meaning: '意思',
          why: '',
          example: '',
          exampleTranslation: ''
        }
      ]
    })

    expect(harness.language.saved[0]?.knowledgePoints[0]?.expression).toHaveLength(120)
  })

  it('deletes the sentence a ref names, and refuses a ref that names nothing', async () => {
    const harness = createHarness()
    await harness.invoke(IPC.languageSave, {
      originalText: '你好',
      translatedText: 'Hello',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      learningLanguage: 'en'
    })
    const filed = harness.language.records[0] as SavedSentence

    const remaining = (await harness.invoke(IPC.languageRemove, {
      id: filed.id,
      nativeLanguage: 'zh',
      learningLanguage: 'en'
    })) as SavedSentence[]

    expect(remaining).toEqual([])
    // An id no pair could have handed out is not something to act on.
    const untouched = (await harness.invoke(IPC.languageRemove, {
      id: 0,
      nativeLanguage: 'zh',
      learningLanguage: 'en'
    })) as SavedSentence[]
    expect(untouched).toEqual([])
  })

  it('clears every saved sentence', async () => {
    const harness = createHarness()
    harness.language.records.push(FILED)

    expect(await harness.invoke(IPC.languageClear)).toEqual([])
    expect(harness.language.records).toEqual([])
  })

  it('tells the renderer when the relation has run out of ids', async () => {
    const harness = createHarness()
    harness.language.failSave = 'exhausted'

    await expect(
      harness.invoke(IPC.languageSave, {
        originalText: '你好',
        translatedText: 'Hello',
        sourceLanguage: 'zh',
        targetLanguage: 'en'
      })
    ).rejects.toThrow('LANGUAGE_PAIR_ID_EXHAUSTED')
  })

  it('streams a mock translation back to the renderer', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, {
      requestId: 'r1',
      text: EXPRESSION,
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    })

    expect(lastDone(harness).text).toBe(MOCK_OUTPUT)
    expect(deltas(harness).map((delta) => delta.text).join('')).toBe(MOCK_OUTPUT)
  })

  it('defaults a payload without a task to the expression path', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, { requestId: 'r1', text: EXPRESSION })

    expect(lastDone(harness).text).toBe(MOCK_OUTPUT)
  })

  it('routes a Learn request to the structured coaching answer', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, analyzePayload())

    const done = lastDone(harness)
    expect(done.text).toBe('')
    expect(done.analysis?.items).toEqual(ANALYSIS_ITEMS)
  })

  it('streams the finished Learn points instead of the raw JSON answer', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, analyzePayload())

    const streamed = deltas(harness)
    expect(streamed.length).toBeGreaterThan(0)
    for (const delta of streamed) {
      expect(delta.text).toBe('')
      expect(delta.analysis?.items.length ?? 0).toBeGreaterThan(0)
    }
    expect(streamed[streamed.length - 1]?.analysis?.items).toHaveLength(ANALYSIS_ITEMS.length)
  })

  it('streams the meaning of what was read, and its points, for an Understand request', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, {
      requestId: 'u1',
      text: READ_SENTENCE,
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      task: 'understand'
    })

    const done = lastDone(harness)
    expect(done.text).toBe(UNDERSTANDING_MEANING)
    expect(done.analysis?.items).toEqual(UNDERSTANDING_ITEMS)
  })

  it('reports a blank input instead of asking the model', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, {
      requestId: 'r1',
      text: '   ',
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    })

    expect(lastFailure(harness).failure.code).toBe('missing-input')
    expect(deltas(harness)).toHaveLength(0)
  })

  it('refuses an input longer than the box allows', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, {
      requestId: 'r1',
      text: 'a'.repeat(MAX_INPUT_CHARS + 1)
    })

    expect(lastFailure(harness).failure.code).toBe('input-too-long')
  })

  it('refuses a Learn request that carries no expression to coach', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, analyzePayload({ result: '' }))

    expect(lastFailure(harness).failure.code).toBe('missing-result')
  })

  it('says the key is missing instead of calling a provider without one', async () => {
    const harness = createHarness({ kind: 'openai-compatible', apiKey: null })

    await harness.invoke(IPC.translateStart, { requestId: 'r1', text: EXPRESSION })

    expect(lastFailure(harness).failure.code).toBe('missing-api-key')
  })

  it('drops a payload that could not have come from the panel', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, { text: EXPRESSION })

    expect(harness.sent).toEqual([])
  })

  it('stops the run the renderer asks it to abandon', async () => {
    const harness = createHarness()

    const run = harness.invoke(IPC.translateStart, { requestId: 'r1', text: EXPRESSION })
    await flush()
    await harness.invoke(IPC.translateCancel, 'r1')
    await run

    expect(lastFailure(harness).failure.code).toBe('cancelled')
    expect(harness.sent.some((message) => message.channel === IPC.translateDone)).toBe(false)
  })

  it('abandons every run in flight when the app is closing', async () => {
    const harness = createHarness()

    const first = harness.invoke(IPC.translateStart, { requestId: 'r1', text: EXPRESSION })
    const second = harness.invoke(IPC.translateStart, { requestId: 'r2', text: '你好' })
    await flush()
    harness.cancelAll()
    await Promise.all([first, second])

    expect(failures(harness).map((failure) => failure.failure.code)).toEqual([
      'cancelled',
      'cancelled'
    ])
  })
})

describe('ipc handlers: Learn files the sentence it analysed', () => {
  it('files what the panel was showing and answers with the record', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, analyzePayload())

    expect(harness.language.learnt).toHaveLength(1)
    const filed = harness.language.learnt[0]
    expect(filed?.originalText).toBe(EXPRESSION)
    expect(filed?.translatedText).toBe(STUDIED)
    expect(filed?.learningLanguage).toBe('en')
    expect(filed?.knowledgePoints).toHaveLength(ANALYSIS_ITEMS.length)

    const done = lastDone(harness)
    expect(done.learned?.knowledgePoints).toHaveLength(ANALYSIS_ITEMS.length)
    expect(done.learnFailure).toBeNull()
  })

  it('tags every filed point with the language it is read aloud in', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, analyzePayload())

    const points = harness.language.records[0]?.knowledgePoints ?? []
    expect(points).toHaveLength(ANALYSIS_ITEMS.length)
    for (const point of points) expect(point.audioLanguage).toBe('en')
  })

  it('files nothing when the request carries no sentence, and says so', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, analyzePayload({ sentence: undefined }))

    const done = lastDone(harness)
    expect(done.learned).toBeNull()
    expect(done.learnFailure).toBe('missing-sentence')
    expect(harness.language.learnt).toHaveLength(0)
    // The note itself still reaches the screen: the analysis was already paid for.
    expect(done.analysis?.items).toHaveLength(ANALYSIS_ITEMS.length)
  })

  it('reports a write that did not land instead of a receipt', async () => {
    const harness = createHarness()
    harness.language.failLearn = 'disk'

    await harness.invoke(IPC.translateStart, analyzePayload())

    const done = lastDone(harness)
    expect(done.learned).toBeNull()
    expect(done.learnFailure).toBe('storage-failed')
    expect(done.analysis?.items).toHaveLength(ANALYSIS_ITEMS.length)
  })

  it('tells the renderer when the relation has run out of ids', async () => {
    const harness = createHarness()
    harness.language.failLearn = 'exhausted'

    await harness.invoke(IPC.translateStart, analyzePayload())

    expect(lastDone(harness).learnFailure).toBe('language-pair-id-exhausted')
  })

  it('counts a second pass over the same sentence on the record it already filed', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, analyzePayload({ requestId: 'one' }))
    await harness.invoke(IPC.translateStart, analyzePayload({ requestId: 'two' }))

    expect(harness.language.records).toHaveLength(1)
    expect(harness.language.records[0]?.studyCount).toBe(2)
    expect(lastDone(harness).learned?.id).toBe(harness.language.records[0]?.id)
  })

  it('files a sentence that was read under the pair the profile names', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, {
      requestId: 'u1',
      text: UNDERSTANDING_MEANING,
      result: READ_SENTENCE,
      task: 'analyze',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      sentence: {
        originalText: READ_SENTENCE,
        translatedText: UNDERSTANDING_MEANING,
        sourceLanguage: 'en',
        targetLanguage: 'zh'
      }
    })

    const record = harness.language.records[0] as SavedSentence
    expect(record.nativeLanguage).toBe('zh')
    expect(record.learningLanguage).toBe('en')
    expect(record.sourceLanguage).toBe('en')
    expect(record.targetLanguage).toBe('zh')
  })

  it('drops a direction that goes nowhere instead of filing a guess', async () => {
    const harness = createHarness()
    const goingNowhere = {
      originalText: 'a',
      translatedText: 'b',
      sourceLanguage: 'en' as LanguageCode,
      targetLanguage: 'en' as LanguageCode
    }

    await harness.invoke(IPC.translateStart, analyzePayload({ sentence: goingNowhere }))

    expect(lastDone(harness).learnFailure).toBe('missing-sentence')
    expect(harness.language.learnt).toHaveLength(0)
  })

  it('never files a translation or an Understand run', async () => {
    const harness = createHarness()

    await harness.invoke(IPC.translateStart, {
      requestId: 'e1',
      text: EXPRESSION,
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    })
    await harness.invoke(IPC.translateStart, {
      requestId: 'u1',
      text: READ_SENTENCE,
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      task: 'understand'
    })

    expect(harness.language.learnt).toHaveLength(0)
    expect(harness.language.saved).toHaveLength(0)
    expect(harness.language.records).toHaveLength(0)
  })
})

describe('ipc handlers: the recent translation list', () => {
  it('remembers a finished translation once the list has been turned on', async () => {
    const harness = createHarness({ recentPolicy: 'on' })

    await harness.invoke(IPC.translateStart, {
      requestId: 'r1',
      text: EXPRESSION,
      sourceLanguage: 'zh',
      targetLanguage: 'en'
    })

    expect(harness.recent.drafts).toHaveLength(1)
    expect(harness.recent.rows[0]?.sourceText).toBe(EXPRESSION)
    expect(harness.recent.rows[0]?.targetText).toBe(MOCK_OUTPUT)
    // Writing goes native -> learning, so the side being studied is what came back.
    expect(harness.recent.rows[0]?.learningLanguage).toBe('en')
  })

  it('remembers the meaning of a sentence that was read', async () => {
    const harness = createHarness({ recentPolicy: 'on' })

    await harness.invoke(IPC.translateStart, {
      requestId: 'u1',
      text: READ_SENTENCE,
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      task: 'understand'
    })

    expect(harness.recent.rows[0]?.sourceText).toBe(READ_SENTENCE)
    expect(harness.recent.rows[0]?.targetText).toBe(UNDERSTANDING_MEANING)
    // Reading walks the relation back, so the side being studied is what came in.
    expect(harness.recent.rows[0]?.learningLanguage).toBe('en')
  })

  it('keeps nothing while the list is switched off, which is how it ships', async () => {
    const harness = createHarness({ recentPolicy: 'off' })

    await harness.invoke(IPC.translateStart, { requestId: 'r1', text: EXPRESSION })

    expect(harness.recent.rows).toEqual([])
  })

  it('never remembers a Learn run, because a note is not a translation', async () => {
    const harness = createHarness({ recentPolicy: 'on' })

    await harness.invoke(IPC.translateStart, analyzePayload())

    expect(harness.recent.rows).toEqual([])
  })

  it('never remembers a translation that came back in the same language', async () => {
    const harness = createHarness({ recentPolicy: 'on' })

    await harness.invoke(IPC.translateStart, {
      requestId: 'r1',
      text: EXPRESSION,
      sourceLanguage: 'zh',
      targetLanguage: 'zh'
    })

    expect(harness.recent.rows).toEqual([])
    expect(lastDone(harness).text).toBe(MOCK_OUTPUT)
  })

  it('reads and clears the list over IPC', async () => {
    const harness = createHarness({ recentPolicy: 'on' })
    await harness.invoke(IPC.translateStart, { requestId: 'r1', text: EXPRESSION })

    const list = (await harness.invoke(IPC.recentList)) as RecentTranslation[]
    expect(list).toHaveLength(1)

    expect(await harness.invoke(IPC.recentClear)).toEqual([])
    expect(harness.recent.rows).toEqual([])
  })

  it('still delivers the translation when the list cannot be written to', async () => {
    const harness = createHarness({ recentPolicy: 'on' })
    harness.recent.failRecord = true

    await harness.invoke(IPC.translateStart, { requestId: 'r1', text: EXPRESSION })

    expect(lastDone(harness).text).toBe(MOCK_OUTPUT)
    expect(failures(harness)).toEqual([])
  })
})

describe('ipc handlers: the browser bridge', () => {
  it('answers with what the bridge service says, rather than guessing', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    const status = (await harness.invoke(IPC.bridgeStatus)) as { token: string; listening: boolean }

    expect(status.token).toBe('token-for-tests')
    expect(status.listening).toBe(false)
  })

  it('mints a new token on request and tells the open settings page about it', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    const status = (await harness.invoke(IPC.bridgeResetToken)) as { token: string }

    expect(status.token).toBe('reset-token-for-tests')
    // The page is showing the old token, so it is told the new one instead of left stale.
    expect(harness.windows.pushed).toEqual([
      { channel: IPC.bridgeStatusChanged, payload: status }
    ])
  })

  it('brings the port in line with the policy whenever the setting moves', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    await harness.invoke(IPC.settingsSet, { browserBridgePolicy: 'on' })
    await harness.invoke(IPC.settingsSet, { browserBridgePolicy: 'off' })
    // The handlers answer before the bridge has caught up - telling the page is deliberately not
    // awaited - so the test waits for the queue to drain rather than counting microtask ticks.
    await flush()

    // Both patches reached the service: opening and closing are one policy, so both have to act.
    expect(harness.bridge.applied).toBe(2)
    // And the token the first patch minted is handed to the page that is waiting to show it.
    expect(harness.windows.pushed.map((message) => message.channel)).toEqual([
      IPC.bridgeStatusChanged,
      IPC.bridgeStatusChanged
    ])
  })

  it('leaves the bridge alone when a patch is about something else', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    await harness.invoke(IPC.settingsSet, { tone: 'casual' })

    expect(harness.bridge.applied).toBe(0)
    expect(harness.windows.pushed).toEqual([])
  })

  it('ignores a policy that is not one of the three, like every other setting', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    await harness.invoke(IPC.settingsSet, { browserBridgePolicy: 'probably' })

    expect((harness.config.lastPatch as { browserBridgePolicy?: string }).browserBridgePolicy).toBeUndefined()
    expect(harness.bridge.applied).toBe(0)
  })

  it('still tells the page what happened when no port could be opened', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })
    harness.bridge.failApply = true

    // A taken port is a state the status can describe, not a failed save: the policy is stored
    // either way, and the page is open showing the token field. Swallowing the refusal and
    // sending the status is what lets it render 'listening: false' instead of a switch that
    // disagrees with the file - and it keeps the rejection off the main process floor.
    await expect(
      harness.invoke(IPC.settingsSet, { browserBridgePolicy: 'on' })
    ).resolves.toBeDefined()
    await flush()

    expect(harness.bridge.applied).toBe(1)
    expect(harness.windows.pushed.map((message) => message.channel)).toEqual([
      IPC.bridgeStatusChanged
    ])
  })
  // The extension travels inside the installer, so the page only has to point the browser at a
  // folder. Handing back the path is what lets「打开扩展文件夹」work on a machine that has never
  // seen this project - and what makes the three browser steps copyable rather than describable.
  it('hands the page the folder the bundled extension was unpacked into', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    expect(await harness.invoke(IPC.extensionOpenFolder)).toEqual({
      ok: true,
      folder: 'C:/tmp/extension',
      message: ''
    })
  })

  // A build without the payload is still a build the user can use, so this is a sentence rather
  // than a rejection: they get told where to look instead of watching a button do nothing.
  it('says so instead of opening nothing when this build carries no extension', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null, extensionFolder: null })

    const result = (await harness.invoke(IPC.extensionOpenFolder)) as ExtensionFolderResult

    expect(result.ok).toBe(false)
    expect(result.folder).toBeNull()
    expect(result.message).not.toBe('')
  })

  // The path survives a refusal so the page can still show it for hand-copying, which is the only
  // way out on a machine whose file manager will not open.
  it('reports a refused open but still names the folder', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null, revealFailure: 'permission denied' })

    expect(await harness.invoke(IPC.extensionOpenFolder)).toEqual({
      ok: false,
      folder: 'C:/tmp/extension',
      message: 'permission denied'
    })
  })
})

/**
 * Exporting My Learning.
 *
 * The feature exists for one reason: a printed page. So what is pinned down here is the contract
 * around the file - a picker that was asked, documents that were written, the folder revealed -
 * and the three ways it can end (nothing to export, cancelled, written), each saying something
 * true rather than the same failure.
 */
describe('ipc handlers: exporting the learning library', () => {
  /** One stored sentence. The export only reads these; nothing here may write. */
  function filed(
    id: number,
    nativeLanguage: LanguageCode,
    learningLanguage: LanguageCode,
    savedAt: string
  ): SavedSentence {
    return {
      id,
      nativeLanguage,
      learningLanguage,
      sourceLanguage: nativeLanguage,
      targetLanguage: learningLanguage,
      originalText: 'original ' + String(id),
      translatedText: 'translated ' + String(id),
      tone: 'natural',
      createdAt: savedAt,
      savedAt,
      studyCount: 1,
      lastReviewedAt: savedAt,
      masteryScore: 0,
      knowledgePoints: []
    }
  }

  it('writes one document per relation and reveals where they landed', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })
    harness.language.records = [
      filed(1, 'zh', 'en', '2026-10-01T00:00:00.000Z'),
      filed(2, 'en', 'zh', '2026-10-02T00:00:00.000Z')
    ]

    const result = (await harness.invoke(IPC.languageExport)) as LearningExportResult

    // Two relations, two documents: Chinese learning English and English learning Chinese are
    // different things to study, so they never share a file.
    expect(result.ok).toBe(true)
    expect(result.folder).toBe('D:/export')
    expect(harness.files.asked).toEqual(['C:/Users/me/Documents/ctoe 学习记录'])
    expect(harness.files.written.flat().map((document) => document.fileName).sort()).toEqual([
      'Chinese_English.docx',
      'English_Chinese.docx'
    ])
    expect(result.files).toHaveLength(2)
    // Selecting the first file is the answer to "where did it go".
    expect(harness.files.revealed).toEqual([result.files[0]])
  })

  it('says there is nothing to export instead of opening a picker', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    expect(await harness.invoke(IPC.languageExport)).toEqual({
      ok: false,
      folder: null,
      files: [],
      message: '还没有学习记录，先点一次 Learn。'
    })
    expect(harness.files.asked).toEqual([])
  })

  it('treats a cancelled picker as a decision, not a failure', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })
    harness.language.records = [filed(1, 'zh', 'en', '2026-10-01T00:00:00.000Z')]
    harness.files.chosen = null

    expect(await harness.invoke(IPC.languageExport)).toEqual({
      ok: false,
      folder: null,
      files: [],
      message: '已取消导出。'
    })
    expect(harness.files.written).toEqual([])
    expect(harness.files.revealed).toEqual([])
  })

  it('does not claim success when the file could not be written', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })
    harness.language.records = [filed(1, 'zh', 'en', '2026-10-01T00:00:00.000Z')]
    harness.files.failWrite = 'disk full'

    const result = (await harness.invoke(IPC.languageExport)) as LearningExportResult

    expect(result.ok).toBe(false)
    expect(result.files).toEqual([])
    expect(result.message).toContain('disk full')
    expect(harness.files.revealed).toEqual([])
  })

  it('opens the data folder, and reports a refusal in words', async () => {
    const harness = createHarness({ kind: 'mock', apiKey: null })

    const opened = (await harness.invoke(IPC.dataOpenFolder)) as DataFolderResult
    expect(opened).toEqual({
      ok: true,
      folder: 'C:/Users/me/AppData/Roaming/ctoe',
      message: ''
    })
    expect(harness.files.opened).toEqual(['C:/Users/me/AppData/Roaming/ctoe'])

    harness.files.openFailure = 'no file manager'
    const refused = (await harness.invoke(IPC.dataOpenFolder)) as DataFolderResult
    expect(refused).toEqual({
      ok: false,
      folder: 'C:/Users/me/AppData/Roaming/ctoe',
      message: 'no file manager'
    })
  })
})
