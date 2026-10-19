import type { ReactElement } from 'react'
import { useBallDrag } from '../hooks/useBallDrag'

/**
 * The always-on-top ball. It only reports press and release: the main process decides
 * whether that was a click (open the panel) or a drag (move the ball).
 */
export function FloatingBall(): ReactElement {
  const drag = useBallDrag()
  return (
    <button
      type="button"
      className="floating-ball"
      aria-label="AI Language Coach"
      title="AI Language Coach · 点击展开，按住可拖动"
      {...drag}
    >
      <span className="floating-ball__glyph" aria-hidden="true">
        AI
      </span>
    </button>
  )
}
