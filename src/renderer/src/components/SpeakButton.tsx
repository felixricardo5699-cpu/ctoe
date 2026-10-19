import type { ReactElement } from 'react'
import type { LanguageCode } from '@shared/language/registry'
import { isSpeaking, useSpeech } from '../hooks/useSpeech'

interface SpeakButtonProps {
  /** The exact line to read. Nothing is read unless the user presses this. */
  text: string
  /**
   * The language to read it in, which is always the language being learned: an explanation in
   * the user's own language is not something they need read back to them.
   */
  language: LanguageCode
  /** What this line is, for the accessible name: "朗读：例句". */
  label: string
  /** Reserved for a future slow replay; without it the engine speaks at normal speed. */
  rate?: number
}

/**
 * The speaker on one line of the lesson. It keeps no state of its own: what is playing lives in
 * the shared speech engine, and this only reports which line that is.
 *
 * Failures are invisible on purpose - no engine, no voice, a refused start - because a learner
 * who cannot hear a sentence must still be able to read it, copy it and keep it.
 */
export function SpeakButton({ text, language, label, rate }: SpeakButtonProps): ReactElement | null {
  const speech = useSpeech()
  // Nothing to say for a line the model left out.
  if (text.trim().length === 0) return null

  const playing = isSpeaking(speech.speakingKey, text, language)
  return (
    <button
      type="button"
      className={playing ? 'speak speak--on' : 'speak'}
      // Pressing it twice is how a line is repeated: the second press stops it.
      aria-label={(playing ? '停止朗读：' : '朗读：') + label}
      aria-pressed={playing}
      title={speech.available ? '朗读' : '当前环境不支持语音'}
      disabled={!speech.available}
      onClick={() => {
        if (playing) speech.stop()
        else speech.speak(text, language, rate)
      }}
    >
      <SpeakerIcon />
    </button>
  )
}

/** A picture rather than a word, because the button has to read the same in six languages. */
function SpeakerIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">
      <path d="M8.2 2.1 4.7 5.2H2.2v5.6h2.5l3.5 3.1z" fill="currentColor" />
      <path
        d="M10.5 5.5a3.4 3.4 0 0 1 0 5M12.4 3.4a6 6 0 0 1 0 9.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

