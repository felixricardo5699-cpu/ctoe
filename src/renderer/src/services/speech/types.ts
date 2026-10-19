import type { LanguageCode } from '@shared/language/registry'

/**
 * Read-aloud, behind the same kind of boundary the AI side has: the UI says "read this text
 * in this language" and never learns where the voice comes from. v1 has exactly one provider
 * - the voices the operating system already owns, reached through the Web Speech API - and a
 * cloud TTS or a bundled model would be another implementation of this interface.
 *
 * Speech is a nice-to-have: every method here is allowed to do nothing. A machine with no
 * voice, or a voice the OS refuses to start, must never cost the user the rest of the app.
 */
export interface SpeakOptions {
  text: string
  /** The language to read it in. Always the language being learned, never the user's own. */
  language: LanguageCode
  /** 1 = normal speed. The parameter exists so a slower replay (0.8) needs no new API. */
  rate?: number
}

/** Normal playback speed. */
export const DEFAULT_SPEECH_RATE = 1

export interface SpeechEngine {
  /** False when this environment has no speech at all, so the UI can stop offering it. */
  available(): boolean
  /** Starts one utterance, replacing whatever was playing. False when it could not start. */
  speak(options: SpeakOptions): boolean
  /** Stops whatever is being read. Safe to call when nothing is playing. */
  cancel(): void
  /** Key of the utterance playing right now (see speakKey), or null. */
  current(): string | null
  /** Fires on every start and stop, so every speaker on screen agrees on what is playing. */
  subscribe(listener: () => void): () => void
}

/**
 * Identity of one spoken line. Two buttons showing the same words in the same language are
 * the same utterance, which is what stops the note and the answer box from both claiming to
 * be playing at once.
 */
export function speakKey(text: string, language: LanguageCode): string {
  return language + '\u0000' + text.trim()
}
