import { useCallback, useEffect, useRef, useState } from 'react'
import { assistantApi } from '../services/assistantApi'

const FEEDBACK_DURATION_MS = 1400

/** What just happened, so the UI can show a short hint or flip a button label. */
export type ClipboardEvent = 'input-copied' | 'output-copied' | 'pasted' | 'empty' | 'unavailable'

export interface UseClipboardTextResult {
  /** Set for a moment after an action, then back to null. */
  lastEvent: ClipboardEvent | null
  copyOutput(text: string): void
  copyInput(text: string): void
  /** Reads the clipboard and hands the text over; the input box decides where it lands. */
  paste(apply: (text: string) => void): void
}

/**
 * Every clipboard interaction in one place. Both boxes need the same 1.4s feedback
 * window, so the timer lives here instead of being duplicated per component.
 */
export function useClipboardText(): UseClipboardTextResult {
  const [lastEvent, setLastEvent] = useState<ClipboardEvent | null>(null)
  const timerRef = useRef<number | null>(null)

  const announce = useCallback((event: ClipboardEvent): void => {
    setLastEvent(event)
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setLastEvent(null), FEEDBACK_DURATION_MS)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    }
  }, [])

  const copy = useCallback(
    (text: string, event: ClipboardEvent): void => {
      if (text.length === 0) return
      void assistantApi()
        .copyText(text)
        .then((ok) => {
          if (ok) announce(event)
        })
        .catch(() => undefined)
    },
    [announce]
  )

  const copyOutput = useCallback((text: string): void => copy(text, 'output-copied'), [copy])
  const copyInput = useCallback((text: string): void => copy(text, 'input-copied'), [copy])

  const paste = useCallback(
    (apply: (text: string) => void): void => {
      void assistantApi()
        .readText()
        .then((text) => {
          // An image-only or empty clipboard would otherwise wipe the box silently.
          if (text.trim().length === 0) {
            announce('empty')
            return
          }
          apply(text)
          announce('pasted')
        })
        .catch(() => announce('unavailable'))
    },
    [announce]
  )

  return { lastEvent, copyOutput, copyInput, paste }
}
