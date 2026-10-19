import { useCallback, useSyncExternalStore } from 'react'
import type { LanguageCode } from '@shared/language/registry'
import { speakKey, speechEngine, type SpeechEngine } from '../services/speech'

export interface Speech {
  /** False when this machine cannot speak at all; the speaker buttons say so instead of lying. */
  available: boolean
  /** Key of the line being read right now (see speakKey), or null. */
  speakingKey: string | null
  /** Reads one line. Nothing is ever spoken unless the user pressed a speaker. */
  speak: (text: string, language: LanguageCode, rate?: number) => void
  stop: () => void
}

/**
 * Read-aloud for one component. The state lives in the shared engine rather than in React, so
 * every speaker on screen flips together - and so a second button can never start a second,
 * overlapping voice.
 */
export function useSpeech(engine: SpeechEngine = speechEngine): Speech {
  const speakingKey = useSyncExternalStore(engine.subscribe, engine.current, engine.current)

  const speak = useCallback(
    (text: string, language: LanguageCode, rate?: number): void => {
      engine.speak({ text, language, rate })
    },
    [engine]
  )

  const stop = useCallback((): void => {
    engine.cancel()
  }, [engine])

  return { available: engine.available(), speakingKey, speak, stop }
}

/** True when the line these words belong to is the one being read. */
export function isSpeaking(speakingKey: string | null, text: string, language: LanguageCode): boolean {
  return speakingKey !== null && speakingKey === speakKey(text, language)
}

