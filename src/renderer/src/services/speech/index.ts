import { createWebSpeechEngine } from './webSpeech'
import type { SpeechEngine } from './types'

/**
 * The one speech engine the whole renderer shares. A single instance is what makes "only one
 * line is ever being read" true everywhere at once - the Learn note, the answer box and My
 * Language all read their playing state from this object.
 *
 * Swapping the provider (a cloud TTS, a bundled voice) is a change to this line and nothing
 * else: no component knows what is behind it.
 */
export const speechEngine: SpeechEngine = createWebSpeechEngine()

export { createWebSpeechEngine } from './webSpeech'
export { DEFAULT_SPEECH_RATE, speakKey } from './types'
export type { SpeakOptions, SpeechEngine } from './types'

