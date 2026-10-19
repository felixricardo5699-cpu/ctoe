/*
 * The browser bridge: the contract between a browser extension and this app.
 *
 * The desktop app is the host and the only owner of the learning data. An extension is an entry
 * point and nothing else: it may hand over a sentence the user pointed at, and it may ask what
 * became of it. It can never write a sentence, never choose the language pair, and never reach the
 * AI - so this file deliberately imports nothing but the registry, the script classifier next to
 * it, and the two domain types it mentions, which keeps it usable by every layer, including a
 * future mobile host.
 *
 * Two rules shape the whole protocol:
 *
 *   - the extension never says which two languages are in play. It cannot know them: the profile
 *     is a setting of the desktop app. It may only *hint* at the language it saw, and the app
 *     decides the direction from its own profile. Learn must never coach the wrong language.
 *   - nothing about the page is stored. The url and title exist to show the user where a sentence
 *     came from, and are dropped when the request is done. Only the sentence is kept, and only
 *     because Learn filed it.
 */

import { MAX_INPUT_CHARS } from '../config/defaults'
import type { LanguageCode } from '../language/registry'
import { isLanguageCode } from '../language/registry'
import { SCRIPT_BY_LANGUAGE, dominantScript } from '../language/script'
import type { BrowserBridgePolicy, SavedSentence } from './index'

/**
 * Wire format version, carried by every health answer. An older app and a newer extension are
 * both real, so the version is stated rather than assumed: an extension that needs more than this
 * app can do reports it instead of guessing at the shape of an answer.
 */
export const BRIDGE_PROTOCOL_VERSION = 1

/** The app answers on the loopback interface only, and never on a public one. */
export const BRIDGE_HOST = '127.0.0.1'

/**
 * The ports the app tries in order and the extension probes in the same order. A range instead of
 * one fixed port keeps the two ends in step without asking the user to configure anything: the
 * app takes the first free one, and eleven probes cost the extension nothing.
 */
export const BRIDGE_PORT_FIRST = 43110
export const BRIDGE_PORT_LAST = 43119

export const BRIDGE_PORTS: readonly number[] = Array.from(
  { length: BRIDGE_PORT_LAST - BRIDGE_PORT_FIRST + 1 },
  (_unused, index) => BRIDGE_PORT_FIRST + index
)

/** The longest sentence the bridge accepts; the same ceiling the input box has. */
export const BRIDGE_MAX_TEXT_CHARS = MAX_INPUT_CHARS

/** A repeated request id inside this window is the same request, not a second one. */
export const BRIDGE_IDEMPOTENCY_WINDOW_MS = 60_000

/** How long a finished task stays readable, so a slow poll still finds its answer. */
export const BRIDGE_TASK_TTL_MS = 10 * 60_000

/** Bytes of request body the server will read before giving up on a request. */
export const BRIDGE_MAX_BODY_BYTES = 256 * 1024

/** Longest url and title the bridge keeps in memory for a pending request. */
export const BRIDGE_MAX_URL_CHARS = 2048
export const BRIDGE_MAX_TITLE_CHARS = 300

/** Every reason the bridge can say no, as a stable code the extension turns into words. */
export const BRIDGE_ERROR_CODES = [
  /** No token, or not the one this app minted. */
  'unauthorized',
  /** The user has the bridge switched off, so nothing is listening. */
  'bridge-off',
  /** The extension speaks a newer protocol than this app understands. */
  'protocol-too-new',
  /** The request carried no text. */
  'empty-text',
  /** Longer than the input box allows. */
  'text-too-long',
  /** The body was not the JSON this protocol describes. */
  'bad-json',
  /** No such task, or it has expired. */
  'not-found',
  /** A newer request arrived while this one was running, so this one was dropped. */
  'superseded',
  /** The app could not file the sentence - the analysis still reached the panel. */
  'storage-failed',
  /** The language pair has handed out its last id. */
  'language-pair-id-exhausted',
  /** The AI call itself failed. */
  'translation-failed',
  /** Something the bridge did not expect. */
  'internal'
] as const

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number]

export function isBridgeErrorCode(value: unknown): value is BridgeErrorCode {
  return typeof value === 'string' && (BRIDGE_ERROR_CODES as readonly string[]).includes(value)
}

/**
 * Which of the two things the user was doing with the sentence. A hint, not an instruction: the
 * app resolves it against its own profile before anything is translated.
 *
 * - 'understand': the text is in the language being learned, and the user wants to read it.
 * - 'express': the text is in the user's own language, and the user wants it in the one they learn.
 */
export const BRIDGE_MODES = ['understand', 'express'] as const

export type BridgeLearnMode = (typeof BRIDGE_MODES)[number]

export function isBridgeLearnMode(value: unknown): value is BridgeLearnMode {
  return typeof value === 'string' && (BRIDGE_MODES as readonly string[]).includes(value)
}

/** What the app knows about the user when it resolves a direction. */
export interface BridgeProfile {
  nativeLanguage: LanguageCode
  learningLanguage: LanguageCode
}

/** GET /v1/health */
export interface BridgeHealth {
  ok: true
  protocol: number
  app: 'ctoe'
  version: string
  /** True while a request is being worked on, so an extension can wait rather than pile up. */
  busy: boolean
}

/** Every refusal, and the only thing an extension has to branch on. */
export interface BridgeErrorBody {
  ok: false
  error: BridgeErrorCode
}

/** POST /v1/learn */
export interface BridgeLearnRequest {
  /** The extension's own id for this attempt; a repeat returns the same task instead of a new one. */
  requestId: string
  /** The sentence the user pointed at, already whitespace-collapsed. */
  text: string
  /**
   * What the extension believes the user was doing. Omitted means 'understand', which is what
   * pointing at a sentence on a page almost always means.
   */
  mode?: BridgeLearnMode
  /**
   * The language the extension saw, from the page or from its own detection. It is a hint: the app
   * accepts it only when the registry knows it, and always decides the direction from the profile.
   */
  langHint?: string
  /** Where it came from, shown to the user while the sentence is being filed. Never stored. */
  url?: string
  title?: string
}

/** 202 for POST /v1/learn: the work was accepted, not finished. */
export interface BridgeLearnAccepted {
  ok: true
  taskId: string
}

export const BRIDGE_TASK_STATES = ['pending', 'learned', 'failed'] as const

export type BridgeTaskState = (typeof BRIDGE_TASK_STATES)[number]

/** GET /v1/task/:taskId */
export interface BridgeTask {
  ok: true
  state: BridgeTaskState
  /** The sentence's own number inside its language pair, or null until it is filed. */
  sentenceId: number | null
  /** The relation the sentence landed in, so an extension can say where it went. */
  pair: BridgeProfile | null
  /** Why nothing was filed; null unless state is 'failed'. */
  failure: BridgeErrorCode | null
  /** The label to show the user, already formatted by the app. Null until it is filed. */
  label: string | null
}

/** POST /v1/pair - the extension checking a token the user pasted into it. */
export interface BridgePairRequest {
  token: string
}

export interface BridgePairAccepted {
  ok: true
  protocol: number
  version: string
}

/**
 * What the settings page draws: whether the port is open, which one it is, the token to paste
 * into the extension, and when the extension last said anything. The token is here on purpose -
 * copying it into the extension is the whole pairing step, so the user has to be able to see it.
 */
export interface BridgeStatus {
  policy: BrowserBridgePolicy
  listening: boolean
  port: number | null
  token: string
  /**
   * ISO-8601 of the last request that got past the token check, or null when none ever has.
   * Kept across restarts, so it answers "when did this last work" rather than "when did this run
   * of the app start".
   */
  lastRequestAt: string | null
}

/**
 * main -> renderer: the sentence a browser request produced, so the panel can show it the way it
 * shows anything else that was learned. It is a receipt, not a second write - the sentence is
 * already in My Learning.
 */
export interface BridgeLearnEvent {
  taskId: string
  sentence: SavedSentence
  /** Where it came from, for the panel to name. Absent when the extension did not say. */
  source: { url: string; title: string }
}

/**
 * The direction a request should run in, resolved in the one place that knows the profile.
 *
 * Three answers, in falling order of confidence:
 *
 *   1. an explicit mode from the extension, taken as given;
 *   2. the page's language tag, when the registry knows it and it names one side of the relation;
 *   3. the text's own writing system, when exactly one side of the relation is written in it.
 *
 * The third step is what makes the feature correct rather than lucky. The extension's hint comes
 * from a page's `lang` attribute, and a great many pages do not have one - so a Chinese speaker
 * learning English who pointed at a Chinese sentence used to be read as pointing at English, which
 * is the one thing this protocol promises never to do. Script is not a language, but for a pair
 * that does not share a script it is a decisive hint, and it is decided here, by the app, exactly
 * like the other two.
 *
 * 'understand' remains the default because that is what pointing at a sentence means: the user met
 * it somewhere and wants to know what it says. It is only kept when neither the tag nor the text
 * can name a side - including the honest case of English, French and Spanish all being Latin.
 */
export function resolveBridgeMode(
  requested: BridgeLearnMode | undefined,
  langHint: string | undefined,
  profile: BridgeProfile,
  text?: string
): BridgeLearnMode {
  if (requested !== undefined) return requested
  const hinted = readLanguageHint(langHint)
  if (hinted !== null) {
    if (hinted === profile.nativeLanguage) return 'express'
    if (hinted === profile.learningLanguage) return 'understand'
  }
  return modeFromScript(text, profile) ?? 'understand'
}

/**
 * The direction the sentence's own script implies, or null when it implies nothing.
 *
 * It only answers when the two languages of the profile are written differently and the text is
 * clearly one of them: that is the case where a reader would say "obviously this is the sentence I
 * am learning" or "obviously this is my own language". Two Latin-script languages, or text in a
 * third language's script, leave the question open and the caller's default stands.
 */
export function modeFromScript(text: string | undefined, profile: BridgeProfile): BridgeLearnMode | null {
  if (text === undefined || text.length === 0) return null
  const script = dominantScript(text)
  if (script === null) return null
  const writtenInNative = SCRIPT_BY_LANGUAGE[profile.nativeLanguage] === script
  const writtenInLearning = SCRIPT_BY_LANGUAGE[profile.learningLanguage] === script
  if (writtenInNative === writtenInLearning) return null
  return writtenInLearning ? 'understand' : 'express'
}

/**
 * A page's language tag, read down to the primary subtag. 'en-US' names English, 'EN' too, and
 * anything the registry does not have - a tag for a language this app cannot teach, or a value
 * that is not a tag at all - reads as no hint rather than as a wrong one.
 *
 * The hierarchy is not consulted on purpose: 'zh-Hant' and 'zh-Hans' are both Chinese here,
 * because the registry draws its lines at the language, not at the script.
 */
export function readLanguageHint(value: unknown): LanguageCode | null {
  if (typeof value !== 'string') return null
  const primary = value.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return isLanguageCode(primary) ? primary : null
}

/** Whether a value is usable as a request id: a short, non-empty, printable token. */
export function isBridgeRequestId(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 64 && /^[A-Za-z0-9._:-]+$/.test(trimmed)
}

/**
 * The body of POST /v1/learn, as the server will act on it. Anything unreadable is dropped rather
 * than trusted, and a request without a usable id or any text is refused whole - the server has
 * nothing to do with either, and inventing them would file a sentence nobody asked for.
 *
 * This lives here, next to the shape it produces, so the trust boundary is one function the tests
 * can drive directly instead of a branch buried in the HTTP layer.
 */
export function sanitizeBridgeLearnRequest(value: unknown): BridgeLearnRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  if (!isBridgeRequestId(source.requestId)) return null
  const text = typeof source.text === 'string' ? source.text.replace(/\s+/g, ' ').trim() : ''
  if (text.length === 0) return null
  const request: BridgeLearnRequest = { requestId: source.requestId.trim(), text }
  if (isBridgeLearnMode(source.mode)) request.mode = source.mode
  const hinted = readLanguageHint(source.langHint)
  if (hinted !== null) request.langHint = hinted
  const url = readShortText(source.url, BRIDGE_MAX_URL_CHARS)
  if (url !== null) request.url = url
  const title = readShortText(source.title, BRIDGE_MAX_TITLE_CHARS)
  if (title !== null) request.title = title
  return request
}

/** A trimmed string within a ceiling, or null when there is nothing usable there. */
function readShortText(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text.length === 0) return null
  return text.slice(0, limit)
}
