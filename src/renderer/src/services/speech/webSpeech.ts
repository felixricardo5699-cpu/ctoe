import { speechTag } from '@shared/language/registry'
import { DEFAULT_SPEECH_RATE, speakKey, type SpeakOptions, type SpeechEngine } from './types'

/**
 * The only platform shapes this file needs. They are declared locally and looked up at call
 * time, so a renderer without the API - or a test - gets "no speech" instead of a crash.
 */
interface Utterance {
  lang: string
  rate: number
  onend: (() => void) | null
  onerror: (() => void) | null
}

type UtteranceCtor = new (text: string) => Utterance

interface Synthesis {
  speak(utterance: Utterance): void
  cancel(): void
}

function synthesis(): Synthesis | null {
  if (typeof window === 'undefined') return null
  const found = (window as unknown as { speechSynthesis?: Synthesis | null }).speechSynthesis
  return found ?? null
}

function utteranceCtor(): UtteranceCtor | null {
  if (typeof window === 'undefined') return null
  const found = (window as unknown as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance
  return typeof found === 'function' ? (found as UtteranceCtor) : null
}

/**
 * Read-aloud through the operating system's own voices. Nothing is recorded, stored or sent
 * anywhere: the line the user pressed the speaker on is handed to the OS and forgotten.
 *
 * Everything that can go wrong here - no engine, no voice for the language, a refused start -
 * is swallowed into "did not play", because a learner who cannot hear a sentence must still be
 * able to read it, copy it and keep it.
 */
export function createWebSpeechEngine(): SpeechEngine {
  const listeners = new Set<() => void>()
  let playing: string | null = null

  const notify = (): void => {
    for (const listener of [...listeners]) listener()
  }

  const clear = (): void => {
    if (playing === null) return
    playing = null
    notify()
  }

  return {
    available(): boolean {
      return synthesis() !== null && utteranceCtor() !== null
    },

    speak({ text, language, rate = DEFAULT_SPEECH_RATE }: SpeakOptions): boolean {
      const voice = synthesis()
      const Ctor = utteranceCtor()
      const words = text.trim()
      if (voice === null || Ctor === null || words.length === 0) return false

      // One voice at a time: pressing a second speaker replaces the first, it does not layer.
      try {
        voice.cancel()
      } catch {
        // Nothing was playing, which is not a problem.
      }

      const utterance = new Ctor(words)
      utterance.lang = speechTag(language)
      utterance.rate = rate
      utterance.onend = clear
      // A failed start is also an end as far as the buttons are concerned.
      utterance.onerror = clear

      playing = speakKey(words, language)
      notify()
      try {
        voice.speak(utterance)
      } catch {
        clear()
        return false
      }
      return true
    },

    cancel(): void {
      try {
        synthesis()?.cancel()
      } catch {
        // Nothing to stop.
      }
      clear()
    },

    current: (): string | null => playing,

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

