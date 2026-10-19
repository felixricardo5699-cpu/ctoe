import { DEFAULT_LEARNING_LANGUAGE, DEFAULT_NATIVE_LANGUAGE } from '../language/registry'
import { DEFAULT_TONE, type PanelSize, type Tone } from '../types'

/**
 * Any OpenAI-compatible endpoint works here; DeepSeek is just the default
 * because it is cheap and fast for short rewriting tasks.
 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
export const DEFAULT_MODEL = 'deepseek-chat'

export const SETTINGS_DEFAULTS = {
  baseUrl: DEFAULT_BASE_URL,
  model: DEFAULT_MODEL,
  tone: DEFAULT_TONE,
  context: '',
  /** The pair the product opens with; both are changeable in settings. */
  nativeLanguage: DEFAULT_NATIVE_LANGUAGE,
  learningLanguage: DEFAULT_LEARNING_LANGUAGE
} as const

/** Nothing in v1 streams forever; this is the point where we give up on a request. */
export const REQUEST_TIMEOUT_MS = 60_000
/**
 * A little below 1.0 on purpose: rewriting wants a natural voice but must not drift
 * away from what the user actually said.
 */
export const REQUEST_TEMPERATURE = 0.7
/** The structured answers (Learn, Understand) are teaching text, not creative writing. */
export const ANALYSIS_TEMPERATURE = 0.3
export const MAX_INPUT_CHARS = 8_000

/**
 * All window numbers are device-independent pixels (DIP), which is exactly what
 * Electron's setBounds/screen APIs use - so 125% / 150% / 200% Windows scaling
 * needs no extra math on our side.
 */
export const BALL_SIZE = 56
/** Keeps the ball from sitting flush against the screen edge. */
export const BALL_SCREEN_MARGIN = 8
export const PANEL_DEFAULTS: PanelSize = { width: 480, height: 520 }
export const PANEL_LIMITS = {
  minWidth: 380,
  minHeight: 320,
  maxWidth: 900,
  maxHeight: 1_000
} as const
/** Gap between the ball and the panel when the panel opens. */
export const PANEL_GAP = 10

/** Ctrl+Shift+Space is the documented default; it is configurable in settings. */
export const DEFAULT_GLOBAL_SHORTCUT = 'CommandOrControl+Shift+Space'
/** Distance the ball must move before a press counts as a drag instead of a click. */
export const DRAG_CLICK_THRESHOLD = 4

export type { Tone }
