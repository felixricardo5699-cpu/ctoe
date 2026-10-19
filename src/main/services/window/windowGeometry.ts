import { BALL_SCREEN_MARGIN, PANEL_GAP, PANEL_LIMITS } from '@shared/config/defaults'
import type { PanelAnchor, PanelSize, Vec2 } from '@shared/types'

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface PanelPlacement {
  bounds: Rect
  anchor: PanelAnchor
}

/**
 * Pure window maths. Everything here is in device-independent pixels, which is what
 * Electron's screen/setBounds APIs speak, so DPI scaling never enters these formulas -
 * keeping them easy to unit test without a display.
 */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Keeps a window fully inside a work area (work areas already exclude the taskbar). */
export function clampToWorkArea(position: Vec2, size: PanelSize, workArea: Rect, margin = 0): Vec2 {
  const minX = workArea.x + margin
  const minY = workArea.y + margin
  const maxX = workArea.x + workArea.width - size.width - margin
  const maxY = workArea.y + workArea.height - size.height - margin
  // The margin is only a preference: when the work area is too small for window + margin
  // (tiny remote desktop, a panel that fills a narrow screen) being fully visible wins.
  // Aligning to the work-area origin also avoids the NaN a negative range would give.
  return {
    x: Math.round(maxX < minX ? workArea.x : clamp(position.x, minX, maxX)),
    y: Math.round(maxY < minY ? workArea.y : clamp(position.y, minY, maxY))
  }
}

export function isFullyVisible(position: Vec2, size: PanelSize, workArea: Rect): boolean {
  return (
    position.x >= workArea.x &&
    position.y >= workArea.y &&
    position.x + size.width <= workArea.x + workArea.width &&
    position.y + size.height <= workArea.y + workArea.height
  )
}

/** Prefers opening downwards; flips above when there is no room below. */
export function choosePanelAnchor(ball: Vec2, ballSize: number, panel: PanelSize, workArea: Rect): PanelAnchor {
  const spaceBelow = workArea.y + workArea.height - (ball.y + ballSize)
  const spaceAbove = ball.y - workArea.y
  if (spaceBelow >= panel.height + PANEL_GAP) return 'below'
  if (spaceAbove >= panel.height + PANEL_GAP) return 'above'
  return spaceBelow >= spaceAbove ? 'below' : 'above'
}

/**
 * Where the panel goes when the user opens it from the ball. The requested size is
 * normalised here as well, so a caller that passes a panel larger than the work area
 * still gets bounds the user can actually see.
 */
export function placePanel(ball: Vec2, ballSize: number, panel: PanelSize, workArea: Rect): PanelPlacement {
  const size = normalizePanelSize(panel, workArea)
  const anchor = choosePanelAnchor(ball, ballSize, size, workArea)
  const desired: Vec2 = {
    x: ball.x + ballSize / 2 - size.width / 2,
    y: anchor === 'below' ? ball.y + ballSize + PANEL_GAP : ball.y - PANEL_GAP - size.height
  }
  const position = clampToWorkArea(desired, size, workArea, BALL_SCREEN_MARGIN)
  return { bounds: { ...position, width: size.width, height: size.height }, anchor }
}

/** First-run ball position: near the bottom-right corner, but never on the edge. */
export function defaultBallPosition(ballSize: number, workArea: Rect): Vec2 {
  const size: PanelSize = { width: ballSize, height: ballSize }
  return clampToWorkArea(
    {
      x: workArea.x + workArea.width - ballSize - 48,
      y: workArea.y + workArea.height - ballSize - 96
    },
    size,
    workArea,
    BALL_SCREEN_MARGIN
  )
}

/** Config files can be edited (or inherited from another screen), so clamp what we load. */
export function normalizePanelSize(size: PanelSize, workArea: Rect): PanelSize {
  const width = clamp(Math.round(size.width), PANEL_LIMITS.minWidth, Math.min(PANEL_LIMITS.maxWidth, workArea.width))
  const height = clamp(
    Math.round(size.height),
    PANEL_LIMITS.minHeight,
    Math.min(PANEL_LIMITS.maxHeight, workArea.height)
  )
  return { width, height }
}

export function normalizeBallPosition(position: Vec2, ballSize: number, workArea: Rect): Vec2 {
  return clampToWorkArea(position, { width: ballSize, height: ballSize }, workArea, BALL_SCREEN_MARGIN)
}
