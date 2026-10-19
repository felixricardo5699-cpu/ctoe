import { useCallback, useEffect, useState } from 'react'
import type { BridgeStatus } from '@shared/types/bridge'
import { assistantApi } from '../services/assistantApi'

export interface UseBrowserBridgeResult {
  /** What the main process says about the listener; null until the first read lands. */
  status: BridgeStatus | null
  errorMessage: string | null
  /** Mints a new pairing token, which unpairs whatever extension had the old one. */
  resetToken(): Promise<void>
}

/**
 * Reads the browser bridge's state for the settings page.
 *
 * There is no "switch it on" call here: the policy is a setting, so the switch saves it the way
 * every other switch on this page does, and what comes back is read from the main process rather
 * than assumed. Resetting the token is an action instead of a value, so it is its own call.
 *
 * The status is re-read when the main process says it changed - the bridge mints its token when it
 * is first turned on, and that token has to appear in the field the user is about to copy it from.
 */
export function useBrowserBridge(): UseBrowserBridgeResult {
  const [status, setStatus] = useState<BridgeStatus | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const read = (): void => {
      assistantApi()
        .getBridgeStatus()
        .then((loaded) => {
          if (!cancelled) setStatus(loaded)
        })
        .catch(() => {
          if (!cancelled) setErrorMessage('无法读取浏览器扩展的连接状态。')
        })
    }
    read()
    const off = assistantApi().onBridgeStatus((next) => {
      if (!cancelled) setStatus(next)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])

  const resetToken = useCallback(async (): Promise<void> => {
    try {
      setStatus(await assistantApi().resetBridgeToken())
      setErrorMessage(null)
    } catch {
      setErrorMessage('重置连接令牌失败，请重试。')
    }
  }, [])

  return { status, errorMessage, resetToken }
}
