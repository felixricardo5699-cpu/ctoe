import { afterEach, describe, expect, it } from 'vitest'
import { nativeLanguageOf } from '@shared/language/pair'
import { sameSentenceIdentity } from '@shared/language/records'
import { BRIDGE_PROTOCOL_VERSION, type BridgeLearnEvent } from '@shared/types/bridge'
import type {
  KnowledgePoint,
  PublicSettings,
  RecentTranslation,
  SavedSentence,
  SavedSentenceDraft,
  SavedSentenceRef
} from '@shared/types'
import { MOCK_ANALYSIS, MOCK_OUTPUT, MOCK_UNDERSTANDING } from '../ai/MockProvider'
import { parseLearningAnalysis } from '@shared/learning/parse'
import type { ConfigStore } from '../config/configStore'
import type { LanguageStore } from '../language/languageStore'
import type { RecentStore, RecentTranslationDraft } from '../recent/recentStore'
import type { TranslationDeps } from '../../ipc/handlers'
import { BridgeService } from './bridgeService'

/*
 * The bridge, driven end to end over HTTP with the mock provider.
 *
 * These run the real listener, the real routing, the real Learn orchestration and the real store
 * writes - only the model and the disk are stand-ins. What they are for is the part that cannot be
 * seen in a unit test of any single file: that a sentence arriving from a browser comes out the
 * other end as a saved sentence in the right language pair, numbered by the app rather than by the
 * caller, and that the refusals are the ones the protocol promises.
 */

const TOKEN = 'a'.repeat(64)

interface BridgeHarness {
  service: BridgeService
  port: number
  config: ConfigStore
  events: BridgeLearnEvent[]
  reveals: number
  records: SavedSentence[]
  drafts: SavedSentenceDraft[]
  /** Everything the bridge asked the store to file, in order. */
  learnt: SavedSentenceDraft[]
  settings: PublicSettings
  setPolicy(policy: PublicSettings['browserBridgePolicy']): void
  mintToken(token: string): void
}

const open: BridgeHarness[] = []

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop()
    if (harness !== undefined) await harness.service.dispose()
  }
})

function fakeConfig(settings: PublicSettings, token: string): ConfigStore {
  const state = { token, lastRequestAt: null as string | null }
  const store = {
    path: 'test-config.json',
    readPublicSettings: () => ({ ...settings }),
    readProviderSettings: () => null,
    readBridgeToken: () => state.token,
    writeBridgeToken: (next: string) => {
      state.token = next
    },
    readBridgeLastRequestAt: () => state.lastRequestAt,
    writeBridgeLastRequestAt: (at: string) => {
      state.lastRequestAt = at
    },
    clearBridgeLastRequestAt: () => {
      state.lastRequestAt = null
    },
    updateSettings: () => ({ ...settings })
  }
  return store as unknown as ConfigStore
}

/**
 * A second harness over the same config - and, when a clock is given, at the same instant - is
 * what reopening the app looks like.
 */
function createHarness(existing: { config?: ConfigStore; now?: () => number } = {}): BridgeHarness {
  const settings: PublicSettings = {
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    tone: 'natural',
    providerKind: 'mock',
    nativeLanguage: 'zh',
    learningLanguage: 'en',
    hasApiKey: false,
    apiKeyEncrypted: false,
    floatingBall: true,
    globalShortcut: 'CommandOrControl+Shift+Space',
    launchAtLogin: false,
    recentPolicy: 'off',
    browserBridgePolicy: 'off'
  }
  const config = existing.config ?? fakeConfig(settings, TOKEN)
  const records: SavedSentence[] = []
  const drafts: SavedSentenceDraft[] = []
  const learnt: SavedSentenceDraft[] = []

  /** The one place the stand-in writes, doing what the real store does with a draft. */
  const file = (draft: SavedSentenceDraft): SavedSentence => {
    const nativeLanguage = nativeLanguageOf(draft, 'zh')
    const existing = records.find((record) => sameSentenceIdentity(record, { ...draft, nativeLanguage }))
    if (existing !== undefined) return existing
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
    const record: SavedSentence = {
      id: records.length + 1,
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
    records.unshift(record)
    return record
  }

  const language = {
    path: 'test-learned.json',
    list: () => records,
    save: (draft: SavedSentenceDraft) => {
      drafts.push(draft)
      file(draft)
      return records
    },
    learn: (draft: SavedSentenceDraft) => {
      learnt.push(draft)
      return file(draft)
    },
    remove: (ref: SavedSentenceRef) => records.filter((record) => record.id !== ref.id),
    clear: () => []
  } as unknown as LanguageStore

  const rows: RecentTranslation[] = []
  const recent = {
    path: 'test-recent.json',
    list: () => rows,
    record: (_draft: RecentTranslationDraft) => rows,
    clear: () => rows
  } as unknown as RecentStore

  const stores: TranslationDeps = { config, language, recent }
  const events: BridgeLearnEvent[] = []
  const harness: BridgeHarness = {
    // A random free port, so a run never collides with a real app or another test.
    service: BridgeService.open({
      config,
      stores,
      onLearned: (event) => events.push(event),
      reveal: () => {
        harness.reveals += 1
      },
      version: '0.0.0-test',
      ports: [0],
      ...(existing.now === undefined ? {} : { now: existing.now })
    }),
    port: 0,
    config,
    events,
    reveals: 0,
    records,
    drafts,
    learnt,
    settings,
    setPolicy: (policy) => {
      settings.browserBridgePolicy = policy
    },
    mintToken: (token) => {
      config.writeBridgeToken(token)
    }
  }
  return harness
}

/** Makes the bridge listen and reports the runnable harness, with the port it took. */
async function startHarness(existing: { config?: ConfigStore; now?: () => number } = {}): Promise<BridgeHarness> {
  const harness = createHarness(existing)
  harness.setPolicy('on')
  await harness.service.applyPolicy()
  const status = harness.service.status()
  if (status.port === null) throw new Error('the bridge did not start listening')
  harness.port = status.port
  open.push(harness)
  return harness
}

interface Answer {
  status: number
  body: unknown
}

async function call(
  harness: BridgeHarness,
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<Answer> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(options.headers ?? {}) }
  if (options.token !== undefined) headers.authorization = 'Bearer ' + options.token
  const response = await fetch('http://127.0.0.1:' + String(harness.port) + path, {
    method: options.method ?? 'POST',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
  })
  const text = await response.text()
  return { status: response.status, body: text.length === 0 ? null : JSON.parse(text) }
}

/** A request id of the shape the protocol accepts, which a sentence is not. */
let requestSequence = 0
function nextRequestId(): string {
  requestSequence += 1
  return 'r-' + String(requestSequence)
}

/** Sends a sentence and waits for the task to stop being pending. */
async function learn(
  harness: BridgeHarness,
  text: string,
  options: { mode?: string; langHint?: string; requestId?: string } = {}
): Promise<{ taskId: string; task: Record<string, unknown> }> {
  const accepted = await call(harness, '/v1/learn', {
    token: TOKEN,
    body: {
        requestId: options.requestId ?? nextRequestId(),
      text,
      ...(options.mode === undefined ? {} : { mode: options.mode }),
      ...(options.langHint === undefined ? {} : { langHint: options.langHint })
    }
  })
  expect(accepted.status).toBe(202)
  const taskId = (accepted.body as { taskId: string }).taskId
  for (let attempt = 0; attempt < 200; attempt++) {
    const answer = await call(harness, '/v1/task/' + taskId, { method: 'GET', token: TOKEN })
    const task = answer.body as Record<string, unknown>
    if (task.state !== 'pending') return { taskId, task }
    await delay(50)
  }
  throw new Error('the bridge never finished the task')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('bridge: the port and the token', () => {
  it('keeps nothing listening until the user turns it on', async () => {
    const harness = createHarness()
    open.push(harness)

    await harness.service.applyPolicy()

    expect(harness.service.status()).toMatchObject({
      policy: 'off',
      listening: false,
      port: null,
      lastRequestAt: null
    })
    // Nothing was minted or rewritten either: a feature nobody switched on leaves no secret
    // behind, and the one already there is not the service's to change.
    expect(harness.service.status().token).toBe(TOKEN)
  })

  it('mints a token when it is switched on for an app that was never paired', async () => {
    const harness = createHarness()
    open.push(harness)
    harness.mintToken('')
    harness.setPolicy('on')

    await harness.service.applyPolicy()

    expect(harness.service.status().token).toHaveLength(64)
  })

  it('mints the token the first time it is turned on, and keeps it', async () => {
    const harness = await startHarness()

    const status = harness.service.status()
    expect(status.listening).toBe(true)
    expect(status.port).toBeGreaterThan(0)
    expect(status.token).toHaveLength(64)

    // Stopping and starting again must not re-pair: the token outlives the listener.
    harness.setPolicy('off')
    await harness.service.applyPolicy()
    harness.setPolicy('on')
    await harness.service.applyPolicy()

    expect(harness.service.status().token).toBe(status.token)
  })

  it('stops listening when the user turns it off', async () => {
    const harness = await startHarness()
    harness.setPolicy('off')

    await harness.service.applyPolicy()

    expect(harness.service.status().listening).toBe(false)
    // The port really is closed, not just reported closed.
    await expect(call(harness, '/v1/health', { method: 'GET' })).rejects.toThrow()
  })

  it('replaces the token when the user resets it, which unpairs the extension', async () => {
    const harness = await startHarness()

    harness.service.resetToken()

    const after = harness.service.status().token
    expect(after).not.toBe(TOKEN)
    expect(after).toHaveLength(64)
    // The extension still holding the old token is refused until it is paired again.
    expect((await call(harness, '/v1/learn', { token: TOKEN, body: { requestId: 'r1', text: 'Hi.' } })).status).toBe(401)
    expect(
      (await call(harness, '/v1/learn', { token: after, body: { requestId: 'r1', text: 'Hi.' } })).status
    ).toBe(202)
  })
})

describe('bridge: health and pairing', () => {
  it('answers health without a token, so an extension can tell what it found', async () => {
    const harness = await startHarness()

    const answer = await call(harness, '/v1/health', { method: 'GET' })

    expect(answer.status).toBe(200)
    expect(answer.body).toEqual({
      ok: true,
      protocol: BRIDGE_PROTOCOL_VERSION,
      app: 'ctoe',
      version: '0.0.0-test',
      busy: false
    })
  })

  it('accepts the token the user pasted, and refuses any other', async () => {
    const harness = await startHarness()

    const right = await call(harness, '/v1/pair', { token: TOKEN, body: { token: TOKEN } })
    const wrong = await call(harness, '/v1/pair', { token: 'b'.repeat(64), body: { token: 'b'.repeat(64) } })

    expect(right.status).toBe(200)
    expect((right.body as { protocol: number }).protocol).toBe(BRIDGE_PROTOCOL_VERSION)
    expect(wrong.status).toBe(401)
    expect(wrong.body).toEqual({ ok: false, error: 'unauthorized' })
  })

  it('refuses anything but the protocol it speaks', async () => {
    const harness = await startHarness()

    const answer = await call(harness, '/v1/learn', {
      token: TOKEN,
      headers: { 'x-ctoe-protocol': String(BRIDGE_PROTOCOL_VERSION + 1) },
      body: { requestId: 'r1', text: 'Hi.' }
    })

    expect(answer.status).toBe(400)
    expect(answer.body).toEqual({ ok: false, error: 'protocol-too-new' })
  })

  it('tells an unauthorized caller nothing about the request it sent', async () => {
    const harness = await startHarness()

    // Even a request that is itself nonsense is answered with the refusal that matters.
    const answer = await call(harness, '/v1/learn', { headers: { 'x-ctoe-protocol': '9' }, body: {} })

    expect(answer.status).toBe(401)
    expect(answer.body).toEqual({ ok: false, error: 'unauthorized' })
  })
})

describe('bridge: a sentence from a page', () => {
  it('files it as a saved sentence and answers with its number', async () => {
    const harness = await startHarness()
    const sentence = 'I was going to join you, but something came up.'

    const { taskId, task } = await learn(harness, sentence)

    expect(taskId).toBe('t1')
    expect(task).toMatchObject({
      ok: true,
      state: 'learned',
      sentenceId: 1,
      label: '#000001',
      failure: null,
      pair: { nativeLanguage: 'zh', learningLanguage: 'en' }
    })
    expect(harness.records).toHaveLength(1)
    expect(harness.records[0]).toMatchObject({
      id: 1,
      nativeLanguage: 'zh',
      learningLanguage: 'en',
      // Reading somebody else's sentence: what the user brought was the English they met.
      sourceLanguage: 'en',
      targetLanguage: 'zh',
      originalText: sentence,
      translatedText: MOCK_UNDERSTANDING_SENTINEL,
      studyCount: 1
    })
    expect(harness.records[0]?.knowledgePoints).toHaveLength(expectedPointCount())
  })

  it('shows the panel what was filed, naming where it came from', async () => {
    const harness = await startHarness()

    await learn(harness, 'I was going to join you, but something came up.')

    expect(harness.reveals).toBe(1)
    expect(harness.events).toHaveLength(1)
    expect(harness.events[0]?.sentence.id).toBe(1)
    expect(harness.events[0]?.source).toEqual({ url: '', title: '' })
  })

  it('coaches the sentence in the language being learned, not the one it came in', async () => {
    const harness = await startHarness()

    await learn(harness, 'I was going to join you, but something came up.')

    // Learn is always asked native -> learning, whatever direction the sentence went, so the
    // coaching note is about the language being studied.
    const draft = harness.learnt[0]
    expect(draft?.learningLanguage).toBe('en')
    expect(draft?.sourceLanguage).toBe('en')
    expect(draft?.targetLanguage).toBe('zh')
  })

  it('reads a sentence the user pointed at in their own language as something to produce', async () => {
    const harness = await startHarness()
    const chinese = '我本来打算加入你们，但临时有点事。'

    const { task } = await learn(harness, chinese, { langHint: 'zh' })

    expect(task.state).toBe('learned')
    expect(harness.records[0]).toMatchObject({
      // Producing goes the other way: the user brought their own language and got the English.
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      originalText: chinese,
      learningLanguage: 'en'
    })
    // The studied line is what came back, so that is what the record keeps as the translation.
    expect(harness.records[0]?.translatedText).toBe(MOCK_OUTPUT)
  })

  it('ignores a hint naming neither side of the profile', async () => {
    const harness = await startHarness()

    await learn(harness, 'Bonjour tout le monde.', { langHint: 'fr' })

    // Nothing to read there, so it falls back to reading - which is the safe default.
    expect(harness.records[0]?.sourceLanguage).toBe('en')
  })

  it('reads the sentence own script when the page said nothing at all', async () => {
    const harness = await startHarness()
    const chinese = '我本来打算加入你们，但临时有点事。'

    // No langHint: the page had no `lang` attribute, which is the common case in the wild. The
    // text's own script is what tells the two sides of this profile apart - and getting it wrong
    // here is what used to coach English at a Chinese sentence.
    const { task } = await learn(harness, chinese)

    expect(task.state).toBe('learned')
    expect(harness.records[0]).toMatchObject({
      nativeLanguage: 'zh',
      learningLanguage: 'en',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      originalText: chinese
    })
  })

  it('records when an extension last spoke, which is what "connected" means', async () => {
    const harness = await startHarness()
    expect(harness.service.status().lastRequestAt).toBeNull()

    await learn(harness, 'I was going to join you, but something came up.')

    expect(harness.service.status().lastRequestAt).not.toBeNull()
  })
})

/*
 * "Connected" is the settings page's word for "an extension holding the right token has reached
 * this app". These pin down what earns it, so the label can be trusted while somebody is working
 * out why a sentence will not go through - which is the only moment it is read closely.
 */
describe('bridge: what "connected" means', () => {
  it('does not count a request that never got past the token check', async () => {
    const harness = await startHarness()

    const answer = await call(harness, '/v1/learn', {
      token: 'not-the-token',
      body: { requestId: nextRequestId(), text: 'Hello there.' }
    })

    expect(answer.status).toBe(401)
    expect(harness.service.status().lastRequestAt).toBeNull()
  })

  it('does not count a health probe, which is open to anything on this machine', async () => {
    const harness = await startHarness()

    await call(harness, '/v1/health', { method: 'GET' })

    expect(harness.service.status().lastRequestAt).toBeNull()
  })

  it('counts pairing, so the settings page agrees as soon as the user connects', async () => {
    const harness = await startHarness()

    const answer = await call(harness, '/v1/pair', { token: TOKEN, body: { token: TOKEN } })

    expect(answer.status).toBe(200)
    expect(harness.service.status().lastRequestAt).not.toBeNull()
  })

  it('survives a restart, so a pairing made yesterday still reads as connected', async () => {
    const at = Date.parse('2026-09-30T09:00:00.000Z')
    const harness = await startHarness({ now: () => at })
    await learn(harness, 'I was going to join you, but something came up.')
    const recorded = harness.service.status().lastRequestAt
    expect(recorded).toBe(new Date(at).toISOString())

    // Same config file, a new service: what the next launch of the app sees.
    const reopened = createHarness({ config: harness.config })
    open.push(reopened)

    expect(reopened.service.status().lastRequestAt).toBe(recorded)
  })

  it('is forgotten when the token is reset, because that unpairs the extension', async () => {
    const harness = await startHarness()
    await learn(harness, 'I was going to join you, but something came up.')
    expect(harness.service.status().lastRequestAt).not.toBeNull()

    harness.service.resetToken()

    expect(harness.service.status().lastRequestAt).toBeNull()
  })
})

describe('bridge: what it refuses', () => {
  it('tells the three refusals a person can act on apart', async () => {
    const harness = await startHarness()

    const empty = await call(harness, '/v1/learn', { token: TOKEN, body: { requestId: 'r1', text: '  ' } })
    const long = await call(harness, '/v1/learn', {
      token: TOKEN,
      body: { requestId: 'r2', text: 'x'.repeat(9000) }
    })
    const shapeless = await call(harness, '/v1/learn', { token: TOKEN, body: { text: 'Hi.' } })

    expect(empty.body).toEqual({ ok: false, error: 'empty-text' })
    expect(long.body).toEqual({ ok: false, error: 'text-too-long' })
    expect(shapeless.body).toEqual({ ok: false, error: 'bad-json' })
    expect(harness.records).toHaveLength(0)
  })

  it('refuses a task id it never minted instead of inventing an answer', async () => {
    const harness = await startHarness()

    const answer = await call(harness, '/v1/task/t99', { method: 'GET', token: TOKEN })

    expect(answer.status).toBe(200)
    expect(answer.body).toMatchObject({ ok: true, state: 'failed', failure: 'not-found', label: null })
  })

  it('refuses a route the protocol does not have', async () => {
    const harness = await startHarness()

    const answer = await call(harness, '/v1/save', { token: TOKEN, body: {} })

    expect(answer.status).toBe(400)
    expect(answer.body).toEqual({ ok: false, error: 'not-found' })
  })
})

describe('bridge: one sentence, one write', () => {
  it('answers a repeated request id with the same task instead of filing twice', async () => {
    const harness = await startHarness()
    const body = { requestId: 'same-id', text: 'I was going to join you, but something came up.' }

    const first = await call(harness, '/v1/learn', { token: TOKEN, body })
    const second = await call(harness, '/v1/learn', { token: TOKEN, body })

    expect(first.status).toBe(202)
    expect(second.status).toBe(202)
    // The second call is answered with the task the first one started, not a new one.
    expect(second.body).toEqual(first.body)

    // The work is still running when the 202 comes back, so the write is checked after it lands.
    const task = await waitForTask(harness, (first.body as { taskId: string }).taskId)
    expect(task.state).toBe('learned')
    // One request reached the store, which is the whole point: a retry is not a second lesson.
    expect(harness.learnt).toHaveLength(1)
  })

  it('drops a run in flight when a newer sentence arrives', async () => {
    const harness = await startHarness()

    const first = await call(harness, '/v1/learn', {
      token: TOKEN,
      body: { requestId: 'first', text: 'I was going to join you, but something came up.' }
    })
    const second = await call(harness, '/v1/learn', {
      token: TOKEN,
      body: { requestId: 'second', text: 'Something came up, so I cannot make it tonight.' }
    })
    const firstId = (first.body as { taskId: string }).taskId
    const secondId = (second.body as { taskId: string }).taskId

    const dropped = await call(harness, '/v1/task/' + firstId, { method: 'GET', token: TOKEN })
    expect(dropped.body).toMatchObject({ state: 'failed', failure: 'superseded' })

    const kept = await waitForTask(harness, secondId)
    expect(kept.state).toBe('learned')
  })
})

/** The understand answer the mock provider gives, read the way the app reads it. */
const MOCK_UNDERSTANDING_SENTINEL = (() => {
  const parsed = JSON.parse(MOCK_UNDERSTANDING) as { meaning: string }
  return parsed.meaning
})()

/** How many points the mock Learn answer holds, read the way the app reads them. */
function expectedPointCount(): number {
  const analysis = parseLearningAnalysis(MOCK_ANALYSIS)
  if (analysis === null) throw new Error('the mock analysis is not readable')
  return analysis.items.length
}

async function waitForTask(
  harness: BridgeHarness,
  taskId: string
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const answer = await call(harness, '/v1/task/' + taskId, { method: 'GET', token: TOKEN })
    const task = answer.body as Record<string, unknown>
    if (task.state !== 'pending') return task
    await delay(50)
  }
  throw new Error('the bridge never finished the task')
}
