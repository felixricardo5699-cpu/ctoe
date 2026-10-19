import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShortcutStatus } from '@shared/types'
import { assistantApi } from '../services/assistantApi'

export interface ShortcutEditor {
  /** The accelerator the OS actually accepted (not necessarily what was typed). */
  accelerator: string
  status: ShortcutStatus | null
  applying: boolean
  apply(next: string): Promise<void>
}

/**
 * Registration happens in the main process because it can fail (another app may own
 * the combination), so the UI mirrors the reported status instead of assuming that
 * whatever was typed is now live.
 */
export function useGlobalShortcut(): ShortcutEditor {
  const [status, setStatus] = useState<ShortcutStatus | null>(null)
  const [applying, setApplying] = useState(false)
  const liveSeen = useRef(false)

  useEffect(() => {
    let api
    try {
      api = assistantApi()
    } catch {
      return
    }
    const off = api.onShortcutStatus((next) => {
      liveSeen.current = true
      setStatus(next)
    })
    void api
      .getShortcutStatus()
      .then((next) => {
        if (!liveSeen.current) setStatus(next)
      })
      .catch(() => undefined)
    return off
  }, [])

  const apply = useCallback(async (next: string): Promise<void> => {
    setApplying(true)
    try {
      const result = await assistantApi().setShortcut(next)
      liveSeen.current = true
      setStatus(result)
    } catch {
      setStatus({ ok: false, accelerator: '', message: '设置快捷键失败，请重试。' })
    } finally {
      setApplying(false)
    }
  }, [])

  return { accelerator: status?.accelerator ?? '', status, applying, apply }
}
