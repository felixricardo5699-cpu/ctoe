import { useEffect } from 'react'

export interface ShortcutHandlers {
  onTranslate(): void
  onCopy(): void
  onRegenerate(): void
}

/**
 * Window-level shortcuts. No global keyboard hook is needed because the window itself
 * has focus while the user is typing; this deliberately avoids a native
 * keyboard-listener dependency.
 */
export function useShortcuts(handlers: ShortcutHandlers): void {
  const { onTranslate, onCopy, onRegenerate } = handlers

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      // Alt+Enter is the documented shortcut, Ctrl/Cmd+Enter the muscle-memory one.
      if (key === 'enter' && !event.shiftKey && (event.altKey || event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        onTranslate()
        return
      }
      if (key === 'r' && event.altKey) {
        event.preventDefault()
        onRegenerate()
        return
      }
      if (key === 'q' && event.altKey) {
        event.preventDefault()
        onCopy()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onTranslate, onCopy, onRegenerate])
}
