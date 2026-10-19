import { describe, expect, it } from 'vitest'
import { BALL_SCREEN_MARGIN, BALL_SIZE, PANEL_DEFAULTS, PANEL_GAP, PANEL_LIMITS } from '@shared/config/defaults'
import {
  choosePanelAnchor,
  clampToWorkArea,
  defaultBallPosition,
  isFullyVisible,
  normalizeBallPosition,
  normalizePanelSize,
  placePanel,
  type Rect
} from './windowGeometry'

/** 1920x1080 at 100% scaling, minus a 48px taskbar. */
const FULL_HD: Rect = { x: 0, y: 0, width: 1920, height: 1032 }
/** Same monitor at 200% scaling: half as many DIPs, so DIP maths must still fit. */
const FULL_HD_200: Rect = { x: 0, y: 0, width: 960, height: 516 }
/** A second monitor to the left, with negative coordinates. */
const LEFT_MONITOR: Rect = { x: -1280, y: -200, width: 1280, height: 1024 }
const SMALL: Rect = { x: 0, y: 0, width: 300, height: 240 }

describe('clampToWorkArea', () => {
  it('leaves a visible position untouched', () => {
    expect(clampToWorkArea({ x: 100, y: 200 }, { width: 56, height: 56 }, FULL_HD)).toEqual({ x: 100, y: 200 })
  })

  it('pulls the ball back when it is off screen (monitor unplugged, resolution change)', () => {
    expect(clampToWorkArea({ x: 5000, y: 5000 }, { width: 56, height: 56 }, FULL_HD, BALL_SCREEN_MARGIN)).toEqual({
      x: 1920 - 56 - BALL_SCREEN_MARGIN,
      y: 1032 - 56 - BALL_SCREEN_MARGIN
    })
    expect(clampToWorkArea({ x: -9999, y: -9999 }, { width: 56, height: 56 }, FULL_HD, BALL_SCREEN_MARGIN)).toEqual({
      x: BALL_SCREEN_MARGIN,
      y: BALL_SCREEN_MARGIN
    })
  })

  it('handles monitors with negative coordinates', () => {
    const clamped = clampToWorkArea({ x: -5000, y: -5000 }, { width: 56, height: 56 }, LEFT_MONITOR, BALL_SCREEN_MARGIN)
    expect(clamped).toEqual({ x: -1280 + BALL_SCREEN_MARGIN, y: -200 + BALL_SCREEN_MARGIN })
    expect(isFullyVisible(clamped, { width: 56, height: 56 }, LEFT_MONITOR)).toBe(true)
  })

  it('drops the margin instead of pushing the window off screen when there is no room', () => {
    const clamped = clampToWorkArea({ x: 10, y: 10 }, PANEL_DEFAULTS, SMALL, BALL_SCREEN_MARGIN)
    expect(Number.isFinite(clamped.x)).toBe(true)
    expect(Number.isFinite(clamped.y)).toBe(true)
    expect(clamped).toEqual({ x: SMALL.x, y: SMALL.y })
  })
})

describe('defaultBallPosition', () => {
  for (const workArea of [FULL_HD, FULL_HD_200, LEFT_MONITOR, SMALL]) {
    it('starts inside ' + workArea.width + 'x' + workArea.height + ' work area', () => {
      const position = defaultBallPosition(BALL_SIZE, workArea)
      expect(isFullyVisible(position, { width: BALL_SIZE, height: BALL_SIZE }, workArea)).toBe(true)
    })
  }
})

describe('placePanel', () => {
  it('opens below the ball when there is room', () => {
    const placement = placePanel({ x: 100, y: 100 }, BALL_SIZE, PANEL_DEFAULTS, FULL_HD)
    expect(placement.anchor).toBe('below')
    expect(placement.bounds.y).toBe(100 + BALL_SIZE + PANEL_GAP)
    expect(placement.bounds.width).toBe(PANEL_DEFAULTS.width)
  })

  it('flips above the ball near the bottom edge', () => {
    const ball = { x: 100, y: FULL_HD.height - BALL_SIZE - 20 }
    const placement = placePanel(ball, BALL_SIZE, PANEL_DEFAULTS, FULL_HD)
    expect(placement.anchor).toBe('above')
    expect(placement.bounds.y).toBe(ball.y - PANEL_GAP - PANEL_DEFAULTS.height)
  })

  it('keeps the panel inside the work area on a narrow or scaled display', () => {
    for (const workArea of [FULL_HD, FULL_HD_200, LEFT_MONITOR, SMALL]) {
      const placement = placePanel({ x: workArea.x + 4, y: workArea.y + 4 }, BALL_SIZE, PANEL_DEFAULTS, workArea)
      expect(placement.bounds.x).toBeGreaterThanOrEqual(workArea.x)
      expect(placement.bounds.x + placement.bounds.width).toBeLessThanOrEqual(workArea.x + workArea.width)
    }
  })

  it('picks the roomier side when neither fits', () => {
    expect(choosePanelAnchor({ x: 0, y: 20 }, BALL_SIZE, PANEL_DEFAULTS, SMALL)).toBe('below')
    expect(choosePanelAnchor({ x: 0, y: 200 }, BALL_SIZE, PANEL_DEFAULTS, SMALL)).toBe('above')
  })
})

describe('normalizePanelSize', () => {
  it('clamps hand-edited sizes into the supported range', () => {
    expect(normalizePanelSize({ width: 10, height: 10 }, FULL_HD)).toEqual({
      width: PANEL_LIMITS.minWidth,
      height: PANEL_LIMITS.minHeight
    })
    expect(normalizePanelSize({ width: 9000, height: 9000 }, FULL_HD_200)).toEqual({
      width: Math.min(PANEL_LIMITS.maxWidth, FULL_HD_200.width),
      height: Math.min(PANEL_LIMITS.maxHeight, FULL_HD_200.height)
    })
    expect(normalizePanelSize(PANEL_DEFAULTS, FULL_HD)).toEqual(PANEL_DEFAULTS)
  })
})

describe('normalizeBallPosition', () => {
  it('is a no-op for a position that is already fine', () => {
    expect(normalizeBallPosition({ x: 300, y: 300 }, BALL_SIZE, FULL_HD)).toEqual({ x: 300, y: 300 })
  })
})
