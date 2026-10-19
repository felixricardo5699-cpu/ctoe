/**
 * Domain types shared by the Electron main process, the preload bridge and the renderer.
 * The only import is the language registry, which is itself dependency-free, so every layer
 * can still import this file safely.
 */
import type { LanguageCode } from '../language/registry'

export const TONES = ['natural', 'casual', 'professional'] as const

export type Tone = (typeof TONES)[number]

export const DEFAULT_TONE: Tone = 'natural'

export const TONE_LABELS: Record<Tone, string> = {
  natural: 'Natural',
  casual: 'Casual',
  professional: 'Professional'
}

export function isTone(value: unknown): value is Tone {
  return typeof value === 'string' && (TONES as readonly string[]).includes(value)
}

/**
 * Provider selection is explicit instead of "guess from settings", so the app never
 * silently shows fake English: 'mock' has to be chosen on purpose in settings.
 */
export const PROVIDER_KINDS = ['openai-compatible', 'mock'] as const

export type ProviderKind = (typeof PROVIDER_KINDS)[number]

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  'openai-compatible': 'OpenAI 兼容 API',
  mock: 'Mock（本地假数据，不联网）'
}

export function isProviderKind(value: unknown): value is ProviderKind {
  return typeof value === 'string' && (PROVIDER_KINDS as readonly string[]).includes(value)
}

/**
 * There is no fixed language pair: which language is which travels with every request, and the
 * supported set lives in one place (src/shared/language/registry.ts) - including the two
 * fallbacks used before anything has been chosen.
 */

/**
 * What the assistant is asked to do.
 * - `express`: "what do you want to say?" -> the natural target-language wording
 * - `analyze`: Learn -> a short coaching note about that wording
 * - `understand`: the other direction - target-language text the user read somewhere else
 *   -> what it means in their language, plus the same kind of coaching points
 */
export const TASKS = ['express', 'analyze', 'understand'] as const

export type TaskKind = (typeof TASKS)[number]

export const DEFAULT_TASK: TaskKind = 'express'

export function isTaskKind(value: unknown): value is TaskKind {
  return typeof value === 'string' && (TASKS as readonly string[]).includes(value)
}

/**
 * The two directions the panel can be in, and the only two the user ever picks from. The
 * direction itself is never in question: it comes from the user's profile (native +
 * learning) plus this mode. 'analyze' is not a mode - Learn is an action either mode can ask
 * for, and it always coaches the learning language.
 */
export type PanelMode = 'express' | 'understand'

/**
 * What each mode is called on screen: the panel's tabs and a saved moment's badge say the same
 * words, because they are the same idea seen twice - once as what the user is about to do, once as
 * what they did.
 */
export const PANEL_MODE_LABELS: Record<PanelMode, string> = {
  express: 'Say it',
  understand: 'Understand'
}

/**
 * The Learn result. One point per thing worth remembering, best first: the model is asked to
 * rank by usefulness (expression > sentence pattern > vocabulary > grammar) and decides how many
 * points the sentence deserves, so a note stays a note instead of turning into a lesson.
 */
export const LEARNING_KINDS = ['expression', 'pattern', 'vocabulary', 'grammar'] as const

export type LearningKind = (typeof LEARNING_KINDS)[number]

export function isLearningKind(value: unknown): value is LearningKind {
  return typeof value === 'string' && (LEARNING_KINDS as readonly string[]).includes(value)
}

export const LEARNING_KIND_LABELS: Record<LearningKind, string> = {
  expression: '表达',
  pattern: '句式',
  vocabulary: '词汇',
  grammar: '语法'
}

/**
 * How much a point is worth the user's attention. It orders the note and nothing else: a point
 * the model calls 'low' is still a point the user chose to keep, so it is never dropped.
 */
export const KNOWLEDGE_IMPORTANCE = ['high', 'medium', 'low'] as const

export type KnowledgeImportance = (typeof KNOWLEDGE_IMPORTANCE)[number]

export const DEFAULT_KNOWLEDGE_IMPORTANCE: KnowledgeImportance = 'medium'

export function isKnowledgeImportance(value: unknown): value is KnowledgeImportance {
  return typeof value === 'string' && (KNOWLEDGE_IMPORTANCE as readonly string[]).includes(value)
}

/** Rank for ordering only; a value that is missing on disk reads as 'medium'. */
export function importanceOf(item: Pick<LearningItem, 'importance'>): KnowledgeImportance {
  return item.importance ?? DEFAULT_KNOWLEDGE_IMPORTANCE
}

/**
 * Safety valve, not a product limit: the model decides how many points a sentence deserves,
 * and this only stops a runaway answer (or a hand-edited file) from filling one note with
 * hundreds of lines.
 */
export const KNOWLEDGE_POINT_SAFETY_LIMIT = 64

/**
 * Per-field ceilings, so one rambling field cannot bloat the file. Over-long values are cut
 * to length rather than dropped: the point is still the user's.
 */
export const KNOWLEDGE_FIELD_LIMITS = {
  text: 120,
  meaning: 240,
  why: 320,
  example: 320,
  exampleTranslation: 320
} as const

export interface LearningItem {
  kind: LearningKind
  /** The exact chunk of the learning language worth reusing. */
  expression: string
  /** Its meaning in the user's own language; short enough to read in one glance. */
  meaning: string
  /** Why a learner should remember it. Empty when the model had nothing to add. */
  why: string
  /** One short sentence in the learning language using it. */
  example: string
  /**
   * The same example said in the user's own language. An example nobody can check themselves
   * is not something a learner can use, so every point carries both halves of the pair.
   * Empty only for answers - and files - written before the field existed.
   */
  exampleTranslation: string
  /**
   * How strongly the model recommends this point. An ordering hint only - read it through
   * importanceOf(), which fills in the default for answers and files written without it.
   */
  importance?: KnowledgeImportance
}

export interface LearningAnalysis {
  items: LearningItem[]
}

/**
 * The answer to "what does this learning-language text I just read mean?".
 * `meaning` is the whole thing in the user's own language, and `items` are the points worth
 * learning from it - the same shape Learn produces, so one panel can render both. Both halves
 * come from one request on purpose: reading a sentence should not cost a second round trip.
 */
export interface Understanding {
  meaning: string
  items: LearningItem[]
}

/**
 * One thing worth learning, inside the sentence it appeared in. A point never travels on its
 * own: it is stored under its sentence and is shown with it, which is the whole difference
 * between "save a word" and "save the moment you met the word".
 */
export interface KnowledgePoint extends LearningItem {
  /** Minted by the store when the sentence is saved, so two runs cannot collide. */
  id: string
  /** The language to read this point aloud in, frozen at save time. */
  audioLanguage: LanguageCode
  /** Always on disk, even when the model left it out of its answer. */
  importance: KnowledgeImportance
}

/**
 * One real language moment: what the user brought, what came back, and the points worth
 * remembering out of it. This is the unit My Learning stores, searches and shows - the id is
 * scoped to its learning relation (1..0xFFFFFF, see formatSentenceId) and is never reused.
 *
 * The relation and the direction are two different facts and both are kept:
 *
 * - native + learning: the relation the user is in ("I speak Chinese and am learning English").
 *   It is what My Learning buckets, counts and numbers by, so Say it and Understand - the same
 *   relation walked in opposite directions - share one id sequence instead of two.
 * - source -> target: which way *this* moment went. It is history, not current settings: later
 *   changing what is being learned must not rewrite a sentence that was already saved.
 *
 * They are kept consistent: the direction is always one of the relation's two directions (see
 * isValidDirection in ../language/pair), which is where the derived helpers live.
 */
/**
 * How much of this sentence the user has actually been through. Learn is the only thing that
 * bumps these today - it is not a test, so nothing is graded - and the review side of the
 * product will read them later without another file migration.
 */
export const MASTERY_SCORE_MAX = 100

export const DEFAULT_MASTERY_SCORE = 0

export interface SavedSentence {
  /** Relation-local id. Stored as a number; only the UI formats it into '#000001'. */
  id: number
  /** The user's own language. Together with learningLanguage this is the relation. */
  nativeLanguage: LanguageCode
  /** The language being studied: what the points teach and what is read aloud. */
  learningLanguage: LanguageCode
  /** The language of originalText. Always one of the two sides of the relation above. */
  sourceLanguage: LanguageCode
  /** The language of translatedText: the other side of the relation. */
  targetLanguage: LanguageCode
  /** What the user brought: what they wanted to say, or the text they were reading. */
  originalText: string
  /** What came back in the other language. */
  translatedText: string
  /** The register it was written in, so a reviewer can tell casual from professional. */
  tone: Tone
  /** ISO-8601, set when the moment happened and never changed afterwards. */
  createdAt: string
  /** ISO-8601, moved forward every time the same sentence is saved again. */
  savedAt: string
  /**
   * How many times this sentence has been studied: 1 when Learn wrote it, one more for every
   * later Learn pass over the same words. Zero is honest for a record that was kept without
   * ever being studied (the old Save button allowed that, and files migrated from it do).
   */
  studyCount: number
  /** ISO-8601 of the most recent study pass, or null when there has never been one. */
  lastReviewedAt: string | null
  /** 0..MASTERY_SCORE_MAX. Only a review sets it; Learn leaves it alone. */
  masteryScore: number
  /** The points found in this sentence. Empty is legal: a sentence can be worth keeping alone. */
  knowledgePoints: KnowledgePoint[]
}

/**
 * What the UI hands over to save. The store owns the id, both timestamps, every point id and the
 * sentence's nativeLanguage - and stamps each point's audioLanguage from the sentence, so the
 * relation and the studied language are each decided in exactly one place.
 *
 * nativeLanguage is left out on purpose: it is the other side of (learningLanguage plus the
 * direction), so asking the caller for it would be a second answer to a settled question.
 */
export type SavedSentenceDraft = Omit<
  SavedSentence,
  | 'id'
  | 'nativeLanguage'
  | 'createdAt'
  | 'savedAt'
  | 'studyCount'
  | 'lastReviewedAt'
  | 'masteryScore'
  | 'knowledgePoints'
> & {
  knowledgePoints: LearningItem[]
}

/**
 * @deprecated The v4 shape: one saved point per record. Kept only so an existing learned.json
 * can still be read and migrated into SavedSentence; nothing new writes it.
 */
export interface LearningRecord {
  id: string
  /** What the user wanted to say. Empty only for records migrated from the older format. */
  sourceText: string
  /** The expression that was on screen when they asked Learn for the note. */
  targetText: string
  /** The register it was written in, so a reviewer can tell casual from professional. */
  tone: Tone
  /** The language of `sourceText`. Stored per record, because a user may learn several. */
  sourceLanguage: LanguageCode
  /** The language of `targetText`. */
  targetLanguage: LanguageCode
  /**
   * The language this record is teaching, which is the whole point of keeping it: from Say it
   * the learning sentence is what the user produced, from Understand it is what they read.
   * Pinned per record so My Learning never has to re-derive which side is the studied one.
   */
  learningLanguage: LanguageCode
  /** The coaching points, each tagged with its kind (see LEARNING_KINDS). */
  items: LearningItem[]
  /** epoch ms */
  savedAt: number
}

/**
 * Which saved sentence to act on. An id is only unique inside one learning relation, so the
 * relation travels with it - the same number exists under Chinese -> English and Chinese -> French.
 *
 * The relation, not the direction: a relation's sentences are the ones that share an id sequence,
 * so that is what addresses one of them.
 */
export interface SavedSentenceRef {
  nativeLanguage: LanguageCode
  learningLanguage: LanguageCode
  id: number
}

export interface TranslationRequest {
  task: TaskKind
  text: string
  tone: Tone
  /** Reserved for future context presets (x / reddit / email / discord). Always empty in v1. */
  context: string
  /** The language of `text`. For 'understand' this is the language being learned. */
  sourceLanguage: LanguageCode
  /** The language of the answer. For 'understand' this is the user's own language. */
  targetLanguage: LanguageCode
  /** The generated expression; only the `analyze` task reads it. */
  result?: string
}

/** Credentials + endpoint used by a provider. Never sent to the renderer. */
export interface ProviderSettings {
  baseUrl: string
  model: string
  apiKey: string
}

/**
 * The window is a single frameless window that morphs between two shapes:
 * 'ball' = the always-on-top floating ball, 'panel' = the AI input panel.
 */
export const WINDOW_MODES = ['ball', 'panel'] as const

export type WindowMode = (typeof WINDOW_MODES)[number]

export function isWindowMode(value: unknown): value is WindowMode {
  return typeof value === 'string' && (WINDOW_MODES as readonly string[]).includes(value)
}

/** Which side of the ball the panel was placed on; drives the expand animation origin. */
export type PanelAnchor = 'above' | 'below'

export interface Vec2 {
  x: number
  y: number
}

export interface PanelSize {
  width: number
  height: number
}

/** Result of registering the global shortcut. `message` is shown when it fails. */
export interface ShortcutStatus {
  ok: boolean
  accelerator: string
  message: string
}

/**
 * One translation the user asked for, as it happened: the short-lived "what was I just doing"
 * list. It is deliberately not learning material - nothing is bucketed by language pair here,
 * a row carries no coaching, and it never grows a lesson inside it.
 *
 * Both languages are the moment's own, so a row still reads true after the user changes what
 * they are learning - the same rule a saved sentence follows.
 */
export interface RecentTranslation {
  /** Minted by the store: a key for the list, not a number anyone shows. */
  id: string
  /** The language of `sourceText`. */
  sourceLanguage: LanguageCode
  /** The language of `targetText`. */
  targetLanguage: LanguageCode
  /**
   * The side of the pair being studied at the time, which is what tells the two directions of
   * one relation apart: Say it comes to it as the target, Understand as the source. Without it a
   * row could be re-learned only while the settings still named the same learning language, so a
   * row carries it the way a saved sentence carries `learningLanguage`.
   *
   * Optional because a row written before this field existed cannot say - the reader falls back to
   * the profile for those, and a row it cannot resolve is simply not learnable.
   */
  learningLanguage?: LanguageCode
  /** The register it was asked for. Missing on rows written before the field existed. */
  tone?: Tone
  /** What the user brought: what they wanted to say, or the text they were reading. */
  sourceText: string
  /** What came back: the expression, or the meaning they were reading for. */
  targetText: string
  /** ISO-8601, when this translation came back. */
  createdAt: string
}

/**
 * Whether the recent list is kept at all. Recording is opt-in, because keeping a record of what
 * someone typed is their call and not a default: this ships 'off' and only an explicit answer
 * turns it on.
 */
export const RECENT_POLICIES = ['on', 'off'] as const

export type RecentPolicy = (typeof RECENT_POLICIES)[number]

export const DEFAULT_RECENT_POLICY: RecentPolicy = 'off'

export function isRecentPolicy(value: unknown): value is RecentPolicy {
  return typeof value === 'string' && (RECENT_POLICIES as readonly string[]).includes(value)
}

/** How many translations the list keeps; past this the oldest row is dropped. */
export const RECENT_TRANSLATION_LIMIT = 50

/**
 * Whether the desktop app listens for the browser extension at all.
 *
 * 'off' really is off: the loopback port is not opened, so no page and no other program on this
 * machine can reach the learning pipeline. Like the recent list it ships 'off', and only an
 * explicit answer turns it on.
 */
export const BROWSER_BRIDGE_POLICIES = ['on', 'off'] as const

export type BrowserBridgePolicy = (typeof BROWSER_BRIDGE_POLICIES)[number]

export const DEFAULT_BROWSER_BRIDGE_POLICY: BrowserBridgePolicy = 'off'

export function isBrowserBridgePolicy(value: unknown): value is BrowserBridgePolicy {
  return (
    typeof value === 'string' && (BROWSER_BRIDGE_POLICIES as readonly string[]).includes(value)
  )
}

/** Safe subset of the settings that the UI is allowed to see. */
export interface PublicSettings {
  baseUrl: string
  model: string
  tone: Tone
  providerKind: ProviderKind
  /** The language the user speaks: what coaching answers are written in. */
  nativeLanguage: LanguageCode
  /** The language being learned: what is produced and what is read. */
  learningLanguage: LanguageCode
  hasApiKey: boolean
  apiKeyEncrypted: boolean
  /** false = classic window mode: no ball, the panel opens on launch. */
  floatingBall: boolean
  globalShortcut: string
  launchAtLogin: boolean
  /** Whether translations are kept in the local recent list (see RecentTranslation). */
  recentPolicy: RecentPolicy
  /** Whether the browser extension may hand sentences to Learn (see BrowserBridgePolicy). */
  browserBridgePolicy: BrowserBridgePolicy
}

export type SettingsPatch = Partial<
  Pick<
    PublicSettings,
    | 'baseUrl'
    | 'model'
    | 'tone'
    | 'providerKind'
    | 'nativeLanguage'
    | 'learningLanguage'
    | 'floatingBall'
    | 'launchAtLogin'
    | 'recentPolicy'
    | 'browserBridgePolicy'
  >
> & {
  /** Empty string clears the stored key, undefined leaves it untouched. */
  apiKey?: string
}

export type TranslationErrorCode =
  | 'missing-input'
  | 'missing-result'
  | 'input-too-long'
  | 'missing-api-key'
  | 'unauthorized'
  | 'model-not-found'
  | 'rate-limited'
  | 'timeout'
  | 'network'
  | 'server-error'
  | 'empty-response'
  | 'malformed-response'
  | 'cancelled'
  /** Learn had no sentence to file: the panel is the only thing that can say which box was which. */
  | 'missing-sentence'
  /** The study pass could not be written. The analysis still reaches the screen. */
  | 'storage-failed'
  /** A relation has handed out its last id, so there is nowhere to file the sentence. */
  | 'language-pair-id-exhausted'
  | 'unknown'

/** Internal error shape. `detail` is developer-facing only and never contains the API key. */
export interface TranslationFailure {
  code: TranslationErrorCode
  detail: string
}
