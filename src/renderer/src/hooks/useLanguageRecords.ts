import { useCallback, useEffect, useState } from 'react'
import type { SavedSentence, SavedSentenceRef } from '@shared/types'
import { assistantApi } from '../services/assistantApi'

export interface UseLanguageRecordsResult {
  /** Every learned sentence, newest first, across every language pair. */
  sentences: SavedSentence[]
  loading: boolean
  errorMessage: string | null
  remove(ref: SavedSentenceRef): Promise<boolean>
  clear(): Promise<void>
}

/**
 * Reads the local My Learning notes. Every mutation returns the new list, so the hook never has
 * to guess what the store did - and a delete really is a delete.
 *
 * There is no write here on purpose: Learn is the one act that files a sentence, and it happens
 * in the main process as part of the answer, so nothing in the renderer can add a record on its
 * own. Remove reports success rather than swallowing it, because a delete that failed must not
 * look like a delete.
 */
export function useLanguageRecords(): UseLanguageRecordsResult {
  const [sentences, setSentences] = useState<SavedSentence[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    assistantApi()
      .listSavedSentences()
      .then((loaded) => {
        if (!cancelled) setSentences(loaded)
      })
      .catch(() => {
        if (!cancelled) setErrorMessage('无法读取本地学习记录。')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const remove = useCallback(async (ref: SavedSentenceRef): Promise<boolean> => {
    try {
      setSentences(await assistantApi().removeSentence(ref))
      return true
    } catch {
      setErrorMessage('删除失败，请重试。')
      return false
    }
  }, [])

  const clear = useCallback(async (): Promise<void> => {
    try {
      setSentences(await assistantApi().clearSentences())
    } catch {
      setErrorMessage('清空失败，请重试。')
    }
  }, [])

  return { sentences, loading, errorMessage, remove, clear }
}
