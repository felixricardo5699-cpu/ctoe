import { useCallback, useEffect, useRef, useState } from 'react'
import { toUserMessage } from '@shared/errors/messages'
import type { LanguageCode } from '@shared/language/registry'
import type {
  LearningAnalysis,
  SavedSentence,
  TaskKind,
  Tone,
  TranslationErrorCode
} from '@shared/types'
import type { TranslateSentence } from '@shared/types/ipc'
import { assistantApi } from '../services/assistantApi'
import { createRequestId } from '../utils/id'

export type TranslationStatus = 'idle' | 'generating' | 'understanding' | 'ready' | 'analyzing' | 'error'

export interface UseTranslationResult {
  /** The main answer on screen: the learning-language wording for 'express', and the
   *  meaning in the user's own language for 'understand'. */
  output: string
  /** The structured Learn/Understand points for the current answer; null until there are any. */
  analysis: LearningAnalysis | null
  /**
   * The sentence the last Learn pass filed, which is the receipt for it: asking Learn is the study
   * act, so the write happens with the answer and this is what came back. Null while no note has
   * been filed yet, or when the write did not land.
   */
  learned: SavedSentence | null
  /** Why the last Learn pass filed nothing. Turned into words by the panel. */
  learnFailure: TranslationErrorCode | null
  status: TranslationStatus
  errorMessage: string | null
  /** True while a request is in flight, so the UI can lock its buttons. */
  busy: boolean
  /** Say it: the user's own language in, the natural learning-language wording out. */
  translate(text: string, tone: Tone): void
  /** Understand: learning-language text in, what it means in the user's own language out. */
  understand(text: string, tone: Tone): void
  regenerate(): void
  /** Learn: the coaching note for the learning-language sentence on screen, from either mode. */
  analyze(): void
  cancel(): void
  /** Closes the Learn note while keeping the answer it describes. */
  dismissAnalysis(): void
  /** Drops the answer on screen, e.g. when the user switches direction. */
  reset(): void
  canRegenerate: boolean
  canAnalyze: boolean
}

/**
 * The user's profile: the language they speak and the one they are learning. Everything the
 * panel can do is derived from these two plus the mode - never from the text in the box - so
 * this is the only pair the hook needs. It is also why Learn can never coach the wrong
 * language: there is exactly one learning language, and the profile names it.
 */
export interface UserProfile {
  native: LanguageCode
  learning: LanguageCode
}

interface LastRequest {
  task: TaskKind
  text: string
  tone: Tone
  sourceLanguage: LanguageCode
  targetLanguage: LanguageCode
}

/**
 * Owns one in-flight request at a time, for the expression, the Learn note and the Understand
 * note. Replies are ignored unless they belong to the current request id, which is what keeps
 * a cancelled run from overwriting a newer one.
 */
export function useTranslation(profile: UserProfile): UseTranslationResult {
  const [output, setOutput] = useState('')
  // Two slots for the points: the ones committed to the screen, and the ones still streaming
  // in. Showing the stream through a separate slot is what lets a failed retry fall back to
  // the previous note instead of leaving half a lesson behind.
  const [committedAnalysis, setCommittedAnalysis] = useState<LearningAnalysis | null>(null)
  const [streamingAnalysis, setStreamingAnalysis] = useState<LearningAnalysis | null>(null)
  const [status, setStatus] = useState<TranslationStatus>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // What the last study pass wrote, and why it wrote nothing. Both belong to the note on screen
  // and are replaced wholesale by every new request, so a stale receipt is never shown next to a
  // sentence it was not about.
  const [learned, setLearned] = useState<SavedSentence | null>(null)
  const [learnFailure, setLearnFailure] = useState<TranslationErrorCode | null>(null)
  // The direction that produced the answer on screen. Learn never changes it: it only
  // annotates an expression that is already there, so it must not be mistaken for a rewrite.
  const [answerTask, setAnswerTask] = useState<TaskKind | null>(null)
  const [hasLastRequest, setHasLastRequest] = useState(false)
  const activeIdRef = useRef<string | null>(null)
  const activeTaskRef = useRef<TaskKind>('express')
  const lastRequestRef = useRef<LastRequest | null>(null)
  const outputRef = useRef('')

  // analyze() needs the finished English at click time without re-rendering on every chunk.
  useEffect(() => {
    outputRef.current = output
  }, [output])

  useEffect(() => {
    const api = assistantApi()
    const offDelta = api.onDelta(({ requestId, text, analysis: partial }) => {
      if (requestId !== activeIdRef.current) return
      if (activeTaskRef.current === 'express') {
        setOutput((previous) => previous + text)
        return
      }
      // Understand streams the meaning of the whole text as a growing snapshot, so that box
      // is replaced rather than appended. Learn sends no text at all.
      if (text.length > 0) setOutput(text)
      if (partial !== undefined && partial !== null) setStreamingAnalysis(partial)
    })
    const offDone = api.onDone(({ requestId, text, analysis: points, learned: filed, learnFailure: failed }) => {
      if (requestId !== activeIdRef.current) return
      const task = activeTaskRef.current
      activeIdRef.current = null
      // The main process already parsed and validated the structured answers; this only stores them.
      if (task === 'express') {
        setOutput(text)
      } else {
        setCommittedAnalysis(points ?? null)
        setStreamingAnalysis(null)
        if (task === 'understand') setOutput(text)
        // The write happened with the answer, in the same round trip: the note and its receipt
        // arrive together, and a run that filed nothing says why instead of showing a receipt.
        if (task === 'analyze') {
          setLearned(filed ?? null)
          setLearnFailure(failed ?? null)
        }
      }
      setStatus('ready')
    })
    const offFailed = api.onFailed(({ requestId, failure }) => {
      if (requestId !== activeIdRef.current) return
      const task = activeTaskRef.current
      activeIdRef.current = null
      // Dropping the in-flight points restores whatever note was already on screen.
      setStreamingAnalysis(null)
      if (failure.code === 'cancelled') {
        setStatus('idle')
        return
      }
      // Developer detail stays in the console; the UI only shows the friendly message.
      console.debug('[ctoe] ' + task + ' failed:', failure.code, failure.detail)
      setErrorMessage(toUserMessage(failure.code))
      setStatus('error')
    })
    return () => {
      offDelta()
      offDone()
      offFailed()
    }
  }, [])

  const start = useCallback(
    (
      task: TaskKind,
      text: string,
      tone: Tone,
      result: string,
      sourceLanguage: LanguageCode,
      targetLanguage: LanguageCode,
      // Learn only: the two boxes as the user saw them, which is what the study pass files.
      sentence?: TranslateSentence
    ): boolean => {
    if (activeIdRef.current !== null) return false
    const requestId = createRequestId()
    activeIdRef.current = requestId
    activeTaskRef.current = task
    setErrorMessage(null)
    if (task !== 'analyze') setAnswerTask(task)
    setStatus(task === 'analyze' ? 'analyzing' : task === 'understand' ? 'understanding' : 'generating')
    // A new request replaces whatever was mid-stream, so no stale point can linger.
    setStreamingAnalysis(null)
    // The receipt is about one run of Learn, so it goes with it.
    setLearned(null)
    setLearnFailure(null)
    if (task !== 'analyze') {
      // A new question replaces the previous answer, in either direction: the old English
      // means nothing next to a Chinese question, and the old Chinese means nothing next to
      // an English one.
      setOutput('')
      setCommittedAnalysis(null)
    }
    void assistantApi()
      .startTranslation({
        requestId,
        text,
        tone,
        context: '',
        sourceLanguage,
        targetLanguage,
        task,
        result,
        sentence
      })
      .catch(() => {
        if (requestId !== activeIdRef.current) return
        activeIdRef.current = null
        setErrorMessage(toUserMessage('unknown'))
        setStatus('error')
      })
      return true
    },
    []
  )

  /**
   * The two directions, decided in the one place that knows the profile. Say it always runs
   * native -> learning and Understand always runs learning -> native, so no caller can hand
   * the pair over backwards and the panel never has to ask which way to go.
   */
  const translate = useCallback(
    (text: string, tone: Tone): void => {
      if (!start('express', text, tone, '', profile.native, profile.learning)) return
      lastRequestRef.current = {
        task: 'express',
        text,
        tone,
        sourceLanguage: profile.native,
        targetLanguage: profile.learning
      }
      setHasLastRequest(true)
    },
    [profile.learning, profile.native, start]
  )

  const understand = useCallback(
    (text: string, tone: Tone): void => {
      // Reading someone else's text is the same pair walked the other way.
      if (!start('understand', text, tone, '', profile.learning, profile.native)) return
      lastRequestRef.current = {
        task: 'understand',
        text,
        tone,
        sourceLanguage: profile.learning,
        targetLanguage: profile.native
      }
      setHasLastRequest(true)
    },
    [profile.learning, profile.native, start]
  )

  const regenerate = useCallback((): void => {
    const last = lastRequestRef.current
    if (last === null) return
    start(last.task, last.text, last.tone, '', last.sourceLanguage, last.targetLanguage)
  }, [start])

  const analyze = useCallback((): void => {
    const last = lastRequestRef.current
    if (last === null) return
    const answer = outputRef.current
    if (answer.trim().length === 0) return
    // Always native -> learning, whatever mode asked: the coaching answer is about the
    // language being learned, and that is the one thing Learn is never allowed to get wrong.
    // Understand asks the mirror image: the meaning is what the user meant, and the sentence
    // they read is what came back in the language being learned.
    const meaning = last.task === 'express' ? last.text : answer
    const studied = last.task === 'express' ? answer : last.text
    // The moment travels as it happened, which is not the direction of this request: Say it
    // came native -> learning, Understand came the other way. Only the panel knows both boxes,
    // so it is the only layer that can say which way round this sentence went - and the main
    // process files exactly that, so My Learning remembers the moment rather than a rewrite of it.
    const sentence: TranslateSentence = {
      originalText: last.text,
      translatedText: answer,
      sourceLanguage: last.sourceLanguage,
      targetLanguage: last.targetLanguage
    }
    start('analyze', meaning, last.tone, studied, profile.native, profile.learning, sentence)
  }, [profile.learning, profile.native, start])

  const cancel = useCallback((): void => {
    const requestId = activeIdRef.current
    if (requestId === null) return
    void assistantApi().cancelTranslation(requestId)
  }, [])

  /**
   * Hides the Learn note without touching the answer: the user asked to close it, not to
   * lose the expression. A note that is still streaming is cancelled first, or its remaining
   * points would land on a block that is already gone.
   */
  const dismissAnalysis = useCallback((): void => {
    const active = activeIdRef.current
    if (active !== null && activeTaskRef.current === 'analyze') {
      activeIdRef.current = null
      void assistantApi().cancelTranslation(active)
      setStatus('ready')
    }
    setCommittedAnalysis(null)
    setStreamingAnalysis(null)
  }, [])

  const reset = useCallback((): void => {
    const active = activeIdRef.current
    if (active !== null) {
      activeIdRef.current = null
      void assistantApi().cancelTranslation(active)
    }
    lastRequestRef.current = null
    setHasLastRequest(false)
    setAnswerTask(null)
    setOutput('')
    setCommittedAnalysis(null)
    setStreamingAnalysis(null)
    setErrorMessage(null)
    setLearned(null)
    setLearnFailure(null)
    setStatus('idle')
  }, [])

  return {
    output,
    analysis: streamingAnalysis ?? committedAnalysis,
    learned,
    learnFailure,
    status,
    errorMessage,
    busy: status === 'generating' || status === 'understanding' || status === 'analyzing',
    translate,
    understand,
    regenerate,
    analyze,
    cancel,
    dismissAnalysis,
    reset,
    canRegenerate: hasLastRequest,
    // Either mode leaves a learning-language sentence on screen with an answer next to it,
    // which is exactly what the coach needs; nothing to Learn until an answer has settled.
    canAnalyze: answerTask !== null && output.trim().length > 0
  }
}
