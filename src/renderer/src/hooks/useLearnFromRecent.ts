import { useCallback, useEffect, useRef, useState } from 'react'
import { toUserMessage } from '@shared/errors/messages'
import type { RecentMoment } from '@shared/language/recentLearn'
import type {
  LearningAnalysis,
  RecentTranslation,
  SavedSentence,
  TranslationErrorCode
} from '@shared/types'
import type { TranslateSentence } from '@shared/types/ipc'
import { assistantApi } from '../services/assistantApi'
import { createRequestId } from '../utils/id'

/** One Learn run over a recent row, as the page needs to draw it. */
export interface RecentLearnRun {
  /** The row being coached. The note belongs to this row and is drawn under it. */
  rowId: string
  /** The note so far; it grows while the answer streams. Null until the first point arrives. */
  analysis: LearningAnalysis | null
  /** The sentence the run filed, which is the receipt for it. Null while nothing has been filed. */
  learned: SavedSentence | null
  /** Why nothing was filed. Turned into words by the panel. */
  learnFailure: TranslationErrorCode | null
  /** True while the answer is still arriving, so the row can lock its button. */
  busy: boolean
}

export interface UseLearnFromRecentResult {
  /** The run on screen, or null when no recent row is being coached. */
  run: RecentLearnRun | null
  /**
   * Sentences this session filed, keyed by the row that filed them. My Learning is the record of
   * everything ever studied, but a row's own receipt is the one piece of it this page can know
   * for certain right after the write, so it is kept here until the page is left.
   */
  filed: Readonly<Record<string, SavedSentence>>
  /** Last failure of the request itself (not of the write); null while nothing has gone wrong. */
  errorMessage: string | null
  /** Coaches one recent row: the sentence analysed is the row's, never the profile's. */
  analyze(row: RecentTranslation, moment: RecentMoment): void
  /** Closes the note while keeping the row's receipt. */
  dismiss(): void
}

/**
 * Learn, asked of one row of the recent list.
 *
 * A row was written by the translation that produced it, and it says which side of itself was
 * being studied (see recentMoment) - so this passes the row's own relation and direction to the
 * main process rather than the current profile's. That is what lets a sentence translated while
 * the user was learning English still be studied under English after they have moved on to French:
 * the request is about the row, and the row is the only thing here that says what it teaches.
 *
 * The write is not this hook's to make. Asking for the analysis is the study act, so the main
 * process files the sentence in the same round trip as the answer (see handlers.storeLearned),
 * and all that is left here is to show the note and report the receipt.
 */
export function useLearnFromRecent(): UseLearnFromRecentResult {
  const [run, setRun] = useState<RecentLearnRun | null>(null)
  const [filed, setFiled] = useState<Record<string, SavedSentence>>({})
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** The run in flight, so a reply for anything else is ignored. */
  const activeRef = useRef<{ requestId: string; rowId: string } | null>(null)

  useEffect(() => {
    const api = assistantApi()
    const offDelta = api.onDelta(({ requestId, analysis: partial }) => {
      if (requestId !== activeRef.current?.requestId) return
      if (partial === undefined || partial === null) return
      setRun((current) => (current === null ? current : { ...current, analysis: partial }))
    })
    const offDone = api.onDone(({ requestId, analysis: points, learned: record, learnFailure: failed }) => {
      const active = activeRef.current
      if (active === null || requestId !== active.requestId) return
      activeRef.current = null
      setRun((current) =>
        current === null
          ? current
          : {
              ...current,
              analysis: points ?? null,
              learned: record ?? null,
              learnFailure: failed ?? null,
              busy: false
            }
      )
      if (record === null || record === undefined) return
      // The row now has a number in My Learning, and it keeps saying so even after the note is
      // closed: the receipt is about an act that happened, not about the note being open.
      setFiled((current) => ({ ...current, [active.rowId]: record }))
    })
    const offFailed = api.onFailed(({ requestId, failure }) => {
      const active = activeRef.current
      if (active === null || requestId !== active.requestId) return
      activeRef.current = null
      setRun((current) => (current === null ? current : { ...current, busy: false }))
      if (failure.code === 'cancelled') return
      console.debug('[ctoe] learn from recent failed:', failure.code, failure.detail)
      setErrorMessage(toUserMessage(failure.code))
    })
    return () => {
      offDelta()
      offDone()
      offFailed()
    }
  }, [])

  const analyze = useCallback((row: RecentTranslation, moment: RecentMoment): void => {
    // One request at a time: a second row waits its turn rather than racing the first.
    if (activeRef.current !== null) return
    const requestId = createRequestId()
    activeRef.current = { requestId, rowId: row.id }
    setErrorMessage(null)
    setRun({ rowId: row.id, analysis: null, learned: null, learnFailure: null, busy: true })
    // The run reads as the moment did: the user's own side in, the studied side being asked
    // about, whatever the current profile happens to be. The sentence travels as the user lived
    // it, so the main process files the row it came from rather than a rewrite of it.
    const sentence: TranslateSentence = {
      originalText: row.sourceText,
      translatedText: row.targetText,
      sourceLanguage: row.sourceLanguage,
      targetLanguage: row.targetLanguage
    }
    void assistantApi()
      .startTranslation({
        requestId,
        text: moment.meaningText,
        tone: moment.tone,
        context: '',
        sourceLanguage: moment.nativeLanguage,
        targetLanguage: moment.learningLanguage,
        task: 'analyze',
        result: moment.studiedText,
        sentence
      })
      .catch(() => {
        if (activeRef.current?.requestId !== requestId) return
        activeRef.current = null
        setRun((current) => (current === null ? current : { ...current, busy: false }))
        setErrorMessage(toUserMessage('unknown'))
      })
  }, [])

  /**
   * Closes the note while keeping the row's receipt. A run still arriving is left to finish,
   * because it is also the write: stopping it midway would cancel the study act the user asked
   * for, and the answer is already paid for.
   */
  const dismiss = useCallback((): void => {
    setRun(null)
  }, [])

  return { run, filed, errorMessage, analyze, dismiss }
}
