import { randomBytes, timingSafeEqual } from 'node:crypto'
import { formatSentenceId } from '@shared/language/sentenceId'
import { DEFAULT_LEARNING_LANGUAGE, DEFAULT_NATIVE_LANGUAGE } from '@shared/language/registry'
import {
  BRIDGE_IDEMPOTENCY_WINDOW_MS,
  BRIDGE_MAX_TEXT_CHARS,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_TASK_TTL_MS,
  isBridgeRequestId,
  sanitizeBridgeLearnRequest,
  type BridgeErrorCode,
  type BridgeLearnEvent,
  type BridgeLearnRequest,
  type BridgeProfile,
  type BridgeStatus,
  type BridgeTask
} from '@shared/types/bridge'
import type { BrowserBridgePolicy } from '@shared/types'
import type { ConfigStore } from '../config/configStore'
import type { TranslationDeps } from '../../ipc/handlers'
import { BRIDGE_TONE, runBridgeLearn } from './learnRequest'
import {
  startBridgeServer,
  type BridgeHttpRequest,
  type BridgeHttpResponse,
  type BridgeServer
} from './localBridgeServer'

/*
 * The browser bridge as a service: who may ask, what happens when they do, and what became of it.
 *
 * Everything here is about *this app's* side of the conversation - the port, the token, the queue
 * of one, and the short-lived record of what each request turned into. The learning itself happens
 * in learnRequest.ts, and the HTTP mechanics happen in localBridgeServer.ts, so this file can be
 * read as the policy of the feature rather than as any of its plumbing.
 *
 * Nothing is remembered about a page: a task holds the sentence it filed and nothing else, and a
 * request that carried a url or a title keeps them only long enough to show the user where the
 * sentence came from.
 */

/** A header an extension may send to declare which version of this protocol it speaks. */
export const BRIDGE_PROTOCOL_HEADER = 'x-ctoe-protocol'

/** Bytes of randomness behind the pairing token. Long enough that guessing is not a strategy. */
const TOKEN_BYTES = 32

/** How many finished tasks are kept before the oldest are dropped, on top of the TTL. */
const TASK_HISTORY_LIMIT = 50

/**
 * How old the recorded "last spoke" has to be before another one is worth writing to disk.
 *
 * A Learn is polled about once a second, and none of those rounds change what the settings page
 * shows. The in-memory value is exact; the file only has to be close enough to answer "when did
 * this last work", so it is refreshed once it has drifted far enough to be visible - which keeps
 * a synchronous write off the path of every poll.
 */
const LAST_REQUEST_WRITE_INTERVAL_MS = 60_000

export interface BridgeServiceDeps {
  config: ConfigStore
  /** The three stores the Learn pipeline needs; the same ones the panel talks to. */
  stores: TranslationDeps
  /** Shows a filed sentence in the panel. The service never draws anything itself. */
  onLearned: (event: BridgeLearnEvent) => void
  /** Brings the window forward, so there is a panel to show the result in. */
  reveal: () => void
  version: string
  /** Injectable clock, so the idempotency window and the task TTL can be tested without waiting. */
  now?: () => number
  /** The ports to try, in order. Tests pass [0] so a run never collides with a real app. */
  ports?: readonly number[]
}

interface TrackedTask {
  id: string
  requestId: string
  state: BridgeTask['state']
  sentenceId: number | null
  pair: BridgeProfile | null
  failure: BridgeErrorCode | null
  createdAt: number
  /** Aborts the run if a newer request arrives, so one stale answer cannot land late. */
  abort: AbortController
}

interface TrackedRequest {
  taskId: string
  at: number
}

/**
 * The bridge, alive for as long as the app is.
 *
 * The policy is read from the settings file rather than held here, so the app always agrees with
 * what the user chose - including after a hand-edit - and the only state this class owns is the
 * one that is genuinely transient: the tasks a still-polling extension might ask about.
 */
export class BridgeService {
  private server: BridgeServer | null = null
  private readonly tasks = new Map<string, TrackedTask>()
  private readonly requests = new Map<string, TrackedRequest>()
  private lastRequestAt: string | null = null
  private sequence = 0

  private constructor(private readonly deps: BridgeServiceDeps) {}

  static open(deps: BridgeServiceDeps): BridgeService {
    const bridge = new BridgeService(deps)
    // Seeded from disk so "connected" survives a restart: the request that proved it may well
    // have arrived during a previous run of the app.
    bridge.lastRequestAt = deps.config.readBridgeLastRequestAt()
    return bridge
  }

  /**
   * Brings the listener in line with the stored policy, minting a token the first time the bridge
   * is actually turned on. Idempotent on purpose: the settings handler calls it after every patch,
   * so this is the one place that decides whether the port should be open.
   */
  async applyPolicy(): Promise<void> {
    const policy = this.policy()
    if (policy !== 'on') {
      await this.stop()
      return
    }
    this.ensureToken()
    if (this.server !== null) return
    this.server = await startBridgeServer((request) => this.route(request), this.deps.ports)
  }

  /** What the settings page draws. */
  status(): BridgeStatus {
    return {
      policy: this.policy(),
      listening: this.server !== null,
      port: this.server === null ? null : this.server.port,
      token: this.deps.config.readBridgeToken(),
      lastRequestAt: this.lastRequestAt
    }
  }

  /**
   * Mints a new token, which is what "reset" means: whatever extension was paired stops working
   * until the user pastes the new one. The listener itself does not care - it checks the header
   * of each request - so nothing has to be restarted.
   */
  resetToken(): BridgeStatus {
    this.deps.config.writeBridgeToken(mintToken())
    // The record was about the pairing, so unpairing takes it with it: leaving "已连接" behind
    // would say the old extension still works when it no longer can.
    this.lastRequestAt = null
    this.deps.config.clearBridgeLastRequestAt()
    return this.status()
  }

  /**
   * Records that a paired caller just spoke, in memory and - at most once a minute - on disk.
   *
   * Deliberately not called for the health probe: that route is open to anything on this machine,
   * including a page in the browser, and a page must not be able to make the settings page say
   * the extension is connected when none is.
   */
  private markSeen(): void {
    const now = this.now()
    const previous = this.lastRequestAt === null ? Number.NaN : Date.parse(this.lastRequestAt)
    this.lastRequestAt = new Date(now).toISOString()
    if (Number.isFinite(previous) && now - previous < LAST_REQUEST_WRITE_INTERVAL_MS) return
    this.deps.config.writeBridgeLastRequestAt(this.lastRequestAt)
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  private policy(): BrowserBridgePolicy {
    return this.deps.config.readPublicSettings().browserBridgePolicy
  }

  private ensureToken(): void {
    if (this.deps.config.readBridgeToken().length === 0) {
      this.deps.config.writeBridgeToken(mintToken())
    }
  }

  private async stop(): Promise<void> {
    const server = this.server
    if (server === null) return
    this.server = null
    // A run in flight belongs to a bridge that is being closed, so it is cancelled rather than
    // left to finish into a panel the user is no longer expecting.
    this.abortRunning()
    await server.close()
  }

  private abortRunning(): void {
    for (const task of this.tasks.values()) {
      if (task.state === 'pending') task.abort.abort()
    }
  }

  /** The whole of the protocol, dispatched. Every branch is one line of policy. */
  private async route(request: BridgeHttpRequest): Promise<BridgeHttpResponse> {
    const path = request.path
    if (request.method === 'GET' && path === '/v1/health') {
      // Unauthenticated on purpose: an extension must be able to tell "nothing is listening"
      // from "I am not paired" before it has a token to try.
      return {
        status: 200,
        body: {
          ok: true,
          protocol: BRIDGE_PROTOCOL_VERSION,
          app: 'ctoe',
          version: this.deps.version,
          busy: this.busy()
        }
      }
    }

    // Everything below carries a token, so it is checked before the request is looked at. An
    // answer that says which part of the protocol was wrong is only owed to a paired caller.
    const authorized = this.tokenMatches(readAuthorization(request.headers.authorization) ?? '')
    if (!authorized) return refuse('unauthorized')
    // Getting past the token check is exactly what "an extension reached this app" means, and it
    // is recorded here rather than where a sentence is filed: pairing counts, so does a poll that
    // only asks what became of one, and a request that is refused for some later reason still
    // proves the extension is there and holding the right token.
    this.markSeen()

    const tooNew = this.tooNew(request)
    if (tooNew !== null) return tooNew

    if (request.method === 'POST' && path === '/v1/pair') return this.pair(request)
    if (request.method === 'POST' && path === '/v1/learn') return this.learn(request)
    if (request.method === 'GET') {
      const taskId = readTaskPath(path)
      if (taskId !== null) return { status: 200, body: this.task(taskId) }
    }
    return refuse('not-found')
  }

  private busy(): boolean {
    for (const task of this.tasks.values()) {
      if (task.state === 'pending') return true
    }
    return false
  }

  /** An extension that speaks a newer protocol than this app is told so rather than misread. */
  private tooNew(request: BridgeHttpRequest): BridgeHttpResponse | null {
    const declared = Number(request.headers[BRIDGE_PROTOCOL_HEADER])
    if (!Number.isFinite(declared) || declared <= BRIDGE_PROTOCOL_VERSION) return null
    return refuse('protocol-too-new')
  }

  /**
   * The pairing call: the user pasted the token into the extension, and this is the extension
   * asking whether it got the right one. The Authorization header was already checked by the
   * router, so reaching here means the token is good - the body copy is checked too so the two
   * spellings can never disagree.
   */
  private pair(request: BridgeHttpRequest): BridgeHttpResponse {
    const token = readToken(request.body)
    if (token !== null && !this.tokenMatches(token)) return refuse('unauthorized')
    return {
      status: 200,
      body: { ok: true, protocol: BRIDGE_PROTOCOL_VERSION, version: this.deps.version }
    }
  }

  private async learn(request: BridgeHttpRequest): Promise<BridgeHttpResponse> {
    const body = request.body
    if (typeof body !== 'object' || body === null) return refuse('bad-json')
    const source = body as Record<string, unknown>
    if (!isBridgeRequestId(source.requestId)) return refuse('bad-json')
    // The three refusals a person can act on are told apart here, before the shape is sanitised:
    // "nothing to learn" and "too long" are answers an extension can put in front of the user.
    const text = typeof source.text === 'string' ? source.text.replace(/\s+/g, ' ').trim() : ''
    if (text.length === 0) return refuse('empty-text')
    if (text.length > BRIDGE_MAX_TEXT_CHARS) return refuse('text-too-long')

    const parsed = sanitizeBridgeLearnRequest(source)
    if (parsed === null) return refuse('bad-json')

    this.prune()
    const seen = this.requests.get(parsed.requestId)
    if (seen !== undefined && this.now() - seen.at < BRIDGE_IDEMPOTENCY_WINDOW_MS) {
      // The same request id again is the same request: an extension that retried because its
      // poll timed out must not file the sentence twice.
      return { status: 202, body: { ok: true, taskId: seen.taskId } }
    }

    const task = this.start(parsed)
    this.requests.set(parsed.requestId, { taskId: task.id, at: this.now() })
    return { status: 202, body: { ok: true, taskId: task.id } }
  }

  /**
   * Starts the work and answers before it is done.
   *
   * This is deliberately not awaited: the extension asked for a sentence to be filed and has to
   * poll for the result, because holding the connection open through two model calls would leave
   * a browser tab waiting on a request that may take half a minute.
   */
  private start(request: BridgeLearnRequest): TrackedTask {
    // One in flight: a newer request is what the user is looking at now, so the older one is
    // dropped rather than queued behind it - and it is dropped loudly, so its extension is not
    // left polling a task that will never finish.
    this.supersedeRunning()

    const task: TrackedTask = {
      id: 't' + String(++this.sequence),
      requestId: request.requestId,
      state: 'pending',
      sentenceId: null,
      pair: null,
      failure: null,
      createdAt: this.now(),
      abort: new AbortController()
    }
    this.tasks.set(task.id, task)
    this.deps.reveal()
    void this.run(task, request)
    return task
  }

  private supersedeRunning(): void {
    for (const running of this.tasks.values()) {
      if (running.state !== 'pending') continue
      running.abort.abort()
      running.state = 'failed'
      running.failure = 'superseded'
    }
  }

  private async run(task: TrackedTask, request: BridgeLearnRequest): Promise<void> {
    const profile = this.profile()
    const outcome = await runBridgeLearn(
      this.deps.stores,
      request,
      profile,
      BRIDGE_TONE,
      task.abort.signal
    )
    if (task.state !== 'pending') return
    if (outcome.sentence === null) {
      task.state = 'failed'
      task.failure = outcome.failure ?? 'internal'
      return
    }
    task.state = 'learned'
    task.sentenceId = outcome.sentence.id
    task.pair = {
      nativeLanguage: outcome.sentence.nativeLanguage,
      learningLanguage: outcome.sentence.learningLanguage
    }
    // The panel is told what happened even though it did not ask: the sentence is already in My
    // Learning, and showing it is the difference between a background write and a lesson.
    this.deps.onLearned({
      taskId: task.id,
      sentence: outcome.sentence,
      source: { url: request.url ?? '', title: request.title ?? '' }
    })
    this.prune()
  }

  private profile(): BridgeProfile {
    const settings = this.deps.config.readPublicSettings()
    return {
      nativeLanguage: settings.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE,
      learningLanguage: settings.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE
    }
  }

  private task(id: string): BridgeTask {
    this.prune()
    const task = this.tasks.get(id)
    if (task === undefined) {
      // Unknown, or expired: an extension says "ask again" rather than showing a stale answer.
      return { ok: true, state: 'failed', sentenceId: null, pair: null, failure: 'not-found', label: null }
    }
    return {
      ok: true,
      state: task.state,
      sentenceId: task.sentenceId,
      pair: task.pair,
      failure: task.failure,
      // The label is formatted here so an extension never has to know how a sentence is numbered.
      label: task.sentenceId === null ? null : formatSentenceId(task.sentenceId)
    }
  }

  private prune(): void {
    const now = this.now()
    for (const [id, task] of this.tasks) {
      if (now - task.createdAt > BRIDGE_TASK_TTL_MS) this.tasks.delete(id)
    }
    // The map keeps insertion order, so dropping from the front drops the oldest finished work.
    while (this.tasks.size > TASK_HISTORY_LIMIT) {
      const oldest = this.tasks.keys().next()
      if (oldest.done === true) break
      const task = this.tasks.get(oldest.value)
      if (task !== undefined && task.state === 'pending') break
      this.tasks.delete(oldest.value)
    }
    for (const [requestId, seen] of this.requests) {
      if (now - seen.at > BRIDGE_IDEMPOTENCY_WINDOW_MS) this.requests.delete(requestId)
    }
  }

  private now(): number {
    return this.deps.now === undefined ? Date.now() : this.deps.now()
  }

  /**
   * Whether a token is the one this app minted. Compared in constant time: a token that is guessed
   * one byte at a time is guessed, so the comparison must not say where it first differed - and a
   * length difference is answered false rather than thrown, since it is just a wrong token.
   */
  private tokenMatches(candidate: string): boolean {
    const expected = this.deps.config.readBridgeToken()
    if (expected.length === 0) return false
    const left = Buffer.from(expected, 'utf8')
    const right = Buffer.from(candidate, 'utf8')
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }
}

function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex')
}

function refuse(error: BridgeErrorCode): BridgeHttpResponse {
  // 401 for the two refusals that are about credentials, 400 for the rest: an extension can act
  // on the difference (ask the user to pair again, versus show the request was not usable).
  const status = error === 'unauthorized' || error === 'bridge-off' ? 401 : 400
  return { status, body: { ok: false, error } }
}

/** The token out of a pair request, or null when there is nothing usable there. */
function readToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const source = body as Record<string, unknown>
  if (typeof source.token !== 'string') return null
  const token = source.token.trim()
  return token.length === 0 ? null : token
}

/** The task id out of a '/v1/task/<id>' path, or null when the path is not that shape. */
function readTaskPath(path: string): string | null {
  const prefix = '/v1/task/'
  if (!path.startsWith(prefix)) return null
  const id = path.slice(prefix.length)
  return id.length === 0 ? null : id
}

/** The token out of an Authorization header, which must be the Bearer form and nothing else. */
function readAuthorization(value: string | undefined): string | null {
  if (value === undefined) return null
  const match = /^Bearer[ ]+(.+)$/i.exec(value.trim())
  if (match === null) return null
  const token = (match[1] ?? '').trim()
  return token.length === 0 ? null : token
}
