// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantApi } from '@shared/types/api'
import { FloatingBall } from './FloatingBall'

interface Harness {
  startBallDrag: ReturnType<typeof vi.fn>
  endBallDrag: ReturnType<typeof vi.fn>
}

function setup(): Harness {
  const startBallDrag = vi.fn(() => Promise.resolve())
  const endBallDrag = vi.fn(() => Promise.resolve())
  window.api = { startBallDrag, endBallDrag } as unknown as AssistantApi
  render(<FloatingBall />)
  return { startBallDrag, endBallDrag }
}

const ball = (): HTMLElement => screen.getByRole('button', { name: 'AI Language Coach' })

afterEach(() => {
  cleanup()
  delete window.api
})

describe('FloatingBall', () => {
  it('reports a press and a release so the main process can move the window', () => {
    const harness = setup()

    fireEvent.pointerDown(ball(), { button: 0, pointerId: 1 })
    expect(harness.startBallDrag).toHaveBeenCalledTimes(1)
    expect(harness.endBallDrag).not.toHaveBeenCalled()

    fireEvent.pointerUp(ball(), { button: 0, pointerId: 1 })
    expect(harness.endBallDrag).toHaveBeenCalledTimes(1)
  })

  it('ignores presses that are not the primary button', () => {
    const harness = setup()

    fireEvent.pointerDown(ball(), { button: 2, pointerId: 1 })

    expect(harness.startBallDrag).not.toHaveBeenCalled()
  })

  it('ends the drag when the pointer is cancelled', () => {
    const harness = setup()

    fireEvent.pointerDown(ball(), { button: 0, pointerId: 7 })
    fireEvent.pointerCancel(ball(), { pointerId: 7 })

    expect(harness.endBallDrag).toHaveBeenCalledTimes(1)
  })

  it('never reports a release it did not start', () => {
    const harness = setup()

    fireEvent.pointerUp(ball(), { button: 0, pointerId: 1 })

    expect(harness.endBallDrag).not.toHaveBeenCalled()
  })
})
