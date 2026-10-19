import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { fireAndForget } from '../services/assistantApi'

export interface BallDragHandlers {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void
  onPointerUp(event: ReactPointerEvent<HTMLElement>): void
  onPointerCancel(event: ReactPointerEvent<HTMLElement>): void
}

/**
 * The main process owns the drag (it follows the cursor and moves the window), so the
 * UI only reports press and release - it never positions anything itself.
 * Pointer capture guarantees the release still arrives when the window slides out from
 * under the cursor during a fast drag.
 */
export function useBallDrag(): BallDragHandlers {
  const pressed = useRef(false)

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0 || pressed.current) return
    pressed.current = true
    event.preventDefault()
    setPointerCapture(event.currentTarget, event.pointerId, true)
    fireAndForget((api) => api.startBallDrag())
  }, [])

  const release = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    if (!pressed.current) return
    pressed.current = false
    setPointerCapture(event.currentTarget, event.pointerId, false)
    fireAndForget((api) => api.endBallDrag())
  }, [])

  return { onPointerDown, onPointerUp: release, onPointerCancel: release }
}

function setPointerCapture(element: Element, pointerId: number, capture: boolean): void {
  try {
    if (capture) element.setPointerCapture(pointerId)
    else if (element.hasPointerCapture(pointerId)) element.releasePointerCapture(pointerId)
  } catch {
    // Pointer capture does not exist in every test environment; the drag still ends
    // on the next pointerup that reaches the element.
  }
}
