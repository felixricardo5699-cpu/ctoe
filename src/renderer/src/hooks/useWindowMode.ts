import { useEffect, useRef, useState } from 'react'
import type { WindowModePayload } from '@shared/types/ipc'
import type { WindowMode } from '@shared/types'
import { assistantApi } from '../services/assistantApi'
import { readInitialWindowMode } from '../utils/windowMode'

const INITIAL: WindowModePayload = { mode: 'panel', anchor: 'below' }

/**
 * Tracks which shape the window currently has. The URL covers the first paint, the
 * pushed events cover every later change, and one getWindowMode() call closes the
 * race where the shape changed before this hook had subscribed.
 */
export function useWindowMode(): WindowModePayload {
  const [payload, setPayload] = useState<WindowModePayload>(() => ({
    ...INITIAL,
    mode: readInitialWindowMode(window.location.search)
  }))
  const sawLiveEvent = useRef(false)

  useEffect(() => {
    let api
    try {
      api = assistantApi()
    } catch {
      return
    }
    const off = api.onWindowMode((next) => {
      sawLiveEvent.current = true
      setPayload(next)
    })
    void api
      .getWindowMode()
      .then((next) => {
        if (!sawLiveEvent.current) setPayload(next)
      })
      .catch(() => undefined)
    return off
  }, [])

  return payload
}

export type { WindowMode }
