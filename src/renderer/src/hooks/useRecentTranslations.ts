import { useCallback, useEffect, useState } from 'react'
import type { RecentTranslation } from '@shared/types'
import { assistantApi } from '../services/assistantApi'

export interface UseRecentTranslationsResult {
  /** What the user just translated, newest first. Empty while the list is off. */
  rows: RecentTranslation[]
  loading: boolean
  errorMessage: string | null
  clear(): Promise<void>
}

/**
 * Reads the local recent translations.
 *
 * Reading and clearing only: a row is written by the translation that produced it, in the main
 * process, so nothing here can add one - and the list is empty unless the user turned recording
 * on. Clearing reports what is left rather than guessing, because a list that failed to clear
 * must not look cleared.
 */
export function useRecentTranslations(): UseRecentTranslationsResult {
  const [rows, setRows] = useState<RecentTranslation[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    assistantApi()
      .listRecentTranslations()
      .then((loaded) => {
        if (!cancelled) setRows(loaded)
      })
      .catch(() => {
        if (!cancelled) setErrorMessage('无法读取最近翻译。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const clear = useCallback(async (): Promise<void> => {
    try {
      setRows(await assistantApi().clearRecentTranslations())
    } catch {
      setErrorMessage('清空失败，请重试。')
    }
  }, [])

  return { rows, loading, errorMessage, clear }
}
