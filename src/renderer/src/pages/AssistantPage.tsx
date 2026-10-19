import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import { MAX_INPUT_CHARS } from '@shared/config/defaults'
import { toUserMessage } from '@shared/errors/messages'
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  languageNativeName,
  textDirection,
  type LanguageCode
} from '@shared/language/registry'
import {
  DEFAULT_TONE,
  type PanelMode,
  type PublicSettings,
  type SettingsPatch,
  type Tone
} from '@shared/types'
import { isBlank } from '@shared/utils/text'
import { AnalysisPanel } from '../components/AnalysisPanel'
import { InputActions } from '../components/InputActions'
import { ModeBar } from '../components/ModeBar'
import { PanelChrome } from '../components/PanelChrome'
import { SpeakButton } from '../components/SpeakButton'
import { StartCard } from '../components/StartCard'
import { StatusBar } from '../components/StatusBar'
import { TextPanel } from '../components/TextPanel'
import { Toolbar } from '../components/Toolbar'
import { useClipboardText, type ClipboardEvent } from '../hooks/useClipboardText'
import { useLanguageRecords } from '../hooks/useLanguageRecords'
import { useShortcuts } from '../hooks/useShortcuts'
import { useTranslation, type UserProfile } from '../hooks/useTranslation'

/** What the input row says right after a clipboard action; null means "say nothing". */
const INPUT_HINTS: Record<ClipboardEvent, string | null> = {
  pasted: '已粘贴',
  'input-copied': '已复制',
  empty: '剪贴板为空',
  unavailable: '读取剪贴板失败',
  'output-copied': null
}

interface PanelLabels {
  /** The question the top box answers, in the words of that mode. */
  prompt: string
  inputPlaceholder: string
  output: string
  outputPlaceholder: string
}

/**
 * The wording of one mode. Every language name in here comes from the profile, so a French
 * speaker learning Spanish gets Spanish boxes - and because the labels are derived from the
 * mode rather than from what is typed, they can never contradict the direction in use.
 */
function panelLabels(mode: PanelMode, pair: UserProfile): PanelLabels {
  const native = languageNativeName(pair.native)
  const learning = languageNativeName(pair.learning)
  if (mode === 'understand') {
    return {
      prompt: 'What does this mean?',
      inputPlaceholder: '把你在别处选中或复制的 ' + learning + ' 粘贴到这里',
      output: 'Meaning',
      outputPlaceholder: '这段内容的' + native + '意思会显示在这里'
    }
  }
  return {
    prompt: 'What do you want to say?',
    inputPlaceholder: '用 ' + native + ' 写下你想说的意思',
    output: 'Natural Expression',
    outputPlaceholder: '自然的 ' + learning + ' 表达会显示在这里'
  }
}

/**
 * What an empty box says. Understand is the one place the generic message would mislead: nobody
 * is trying to say anything there, they are trying to read something.
 */
function emptyInputMessage(mode: PanelMode, pair: UserProfile): string {
  if (mode === 'express') return toUserMessage('missing-input')
  return '请先粘贴或输入你想读懂的 ' + languageNativeName(pair.learning) + ' 内容。'
}

interface AssistantPageProps {
  settings: PublicSettings | null
  onSaveSettings: (patch: SettingsPatch) => Promise<void>
  onOpenSettings: () => void
  onOpenLanguage: () => void
  onOpenRecent: () => void
}

export function AssistantPage({
  settings,
  onSaveSettings,
  onOpenSettings,
  onOpenLanguage,
  onOpenRecent
}: AssistantPageProps): ReactElement {
  const [mode, setMode] = useState<PanelMode>('express')
  // Each mode keeps its own text: the English someone pasted in to read is still there when they
  // come back to it, and switching never leaves one mode's text under the other mode's label.
  const [expressInput, setExpressInput] = useState('')
  const [understandInput, setUnderstandInput] = useState('')
  const [localError, setLocalError] = useState<string | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  const pair: UserProfile = {
    native: settings?.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE,
    learning: settings?.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE
  }
  const {
    output,
    analysis,
    status,
    errorMessage,
    busy,
    translate,
    understand,
    regenerate,
    analyze,
    cancel,
    learned,
    learnFailure,
    dismissAnalysis,
    reset,
    canRegenerate,
    canAnalyze
  } = useTranslation(pair)
  const { lastEvent, copyOutput, copyInput, paste } = useClipboardText()
  // 只看条数，用来判断"学过没有"；loading 期间先不画卡片，否则老用户每次开面板都会闪一下。
  const { sentences, loading: recordsLoading } = useLanguageRecords()

  const tone: Tone = settings?.tone ?? DEFAULT_TONE
  const isMock = settings?.providerKind === 'mock'
  // A missing settings object is the very first render; assume ball mode like the config default.
  const floatingBall = settings?.floatingBall ?? true
  const express = mode === 'express'
  const labels = panelLabels(mode, pair)
  const input = express ? expressInput : understandInput
  const setInput = express ? setExpressInput : setUnderstandInput
  /**
   * The language in the top box, from the mode plus the profile and from nothing else: Say it is
   * always the user's own language, Understand is always the one being learned. Only the box's own
   * direction needs it - the answer box follows its content - and the hook reads the profile for
   * the pair it sends, so nothing on this page can hand the direction over backwards.
   */
  const source: LanguageCode = express ? pair.native : pair.learning
  /**
   * 第一次用的三步卡：只有还没走完、而且面板还空着的时候才画。三个"做完没有"的条件全是已经存在的
   * 状态，所以这不是新功能开关，而是"把散在各处的进度收在一处"。
   *
   * 一旦用户开始输入、有了结果、或者打开了 Learn 笔记，它就让位：引导是给空面板看的，
   * 没有理由把正在用的东西挤出这个固定高度的窗口。
   */
  const sessionStarted = busy || input.trim().length > 0 || output.length > 0 || analysis !== null
  const firstRun =
    settings !== null &&
    !recordsLoading &&
    !sessionStarted &&
    !(settings.hasApiKey && sentences.length > 0 && settings.browserBridgePolicy === 'on')
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  /**
   * Switching modes changes what the boxes mean, so the answer that was sitting under the other
   * mode's label goes: an English sentence left under "Meaning" would be a lie. The drafts stay,
   * because retyping what you already wrote is not what changing mode should cost.
   */
  const handleModeChange = useCallback(
    (next: PanelMode): void => {
      if (next === mode) return
      setMode(next)
      setLocalError(null)
      reset()
      window.requestAnimationFrame(() => inputRef.current?.focus())
    },
    [mode, reset]
  )

  // Cheap local validation first: no point spending an API call on an empty box.
  const handleRun = useCallback((): void => {
    if (busy) return
    if (isBlank(input)) {
      setLocalError(emptyInputMessage(mode, pair))
      return
    }
    if (input.length > MAX_INPUT_CHARS) {
      setLocalError(toUserMessage('input-too-long'))
      return
    }
    setLocalError(null)
    // Which way the request goes is the mode's business and the hook reads the profile itself,
    // so nothing on this path is able to send the pair backwards.
    if (express) translate(input, tone)
    else understand(input, tone)
  }, [busy, express, input, mode, pair.learning, pair.native, tone, translate, understand])

  // Learn only ever describes an expression that is already on screen.
  const handleLearn = useCallback((): void => {
    setLocalError(null)
    analyze()
  }, [analyze])

  // Closing the note is not the same as dropping the answer, so the expression stays put and
  // Learn can be asked again.
  const handleDismissAnalysis = useCallback((): void => {
    setLocalError(null)
    dismissAnalysis()
  }, [dismissAnalysis])

  const handleCopy = useCallback((): void => {
    copyOutput(output)
  }, [copyOutput, output])

  const handleCopyInput = useCallback((): void => {
    copyInput(input)
  }, [copyInput, input])


  /**
   * Pulls the clipboard into the box the user is working in. Text copied from another app
   * lands at the caret instead of replacing what is already there.
   *
   * This is also the whole of "Understand": Windows has no way to hand an app the text a user
   * selected in someone else's window without reading that window through accessibility APIs
   * or synthesising Ctrl+C, and this tool does neither. So the user copies once and pastes
   * once, both deliberately, and nothing is read until they ask for it.
   */
  const handlePasteInput = useCallback((): void => {
    paste((text: string) => {
      const element = inputRef.current
      const start = element?.selectionStart ?? null
      const end = element?.selectionEnd ?? null
      setInput((current) => {
        // Without caret info (box not focused yet) appending is the safe guess.
        if (start === null || end === null) return current.length === 0 ? text : current + text
        return current.slice(0, start) + text + current.slice(end)
      })
      setLocalError(null)
      // Leave the caret after the pasted text, the way a real paste behaves.
      window.requestAnimationFrame(() => {
        const next = inputRef.current
        if (next === null) return
        const caret = (start ?? next.value.length) + text.length
        next.focus()
        next.setSelectionRange(caret, caret)
      })
    })
  }, [paste, setInput])

  const handleToneChange = useCallback(
    (next: Tone): void => {
      void onSaveSettings({ tone: next })
    },
    [onSaveSettings]
  )

  useShortcuts({ onTranslate: handleRun, onCopy: handleCopy, onRegenerate: regenerate })

  return (
    <div className="assistant">
      <header className="assistant__header">
        <h1 className="assistant__title">AI Language Coach</h1>
        <div className="assistant__header-actions">
          {isMock ? <span className="badge">Mock 模式</span> : null}
          <button type="button" className="button button--ghost" onClick={onOpenLanguage}>
            My Learning
          </button>
          <button type="button" className="button button--ghost" onClick={onOpenRecent}>
            最近翻译
          </button>
          <button type="button" className="button button--ghost" onClick={onOpenSettings}>
            设置
          </button>
          <PanelChrome floatingBall={floatingBall} shortcut={settings?.globalShortcut} />
        </div>
      </header>

      {firstRun ? (
        <StartCard
          settings={settings}
          learnedCount={sentences.length}
          onFocusInput={() => window.requestAnimationFrame(() => inputRef.current?.focus())}
          onOpenSettings={onOpenSettings}
        />
      ) : null}

      <ModeBar
        mode={mode}
        nativeName={languageNativeName(pair.native)}
        learningName={languageNativeName(pair.learning)}
        disabled={busy}
        onChange={handleModeChange}
      />

      <TextPanel
        label={labels.prompt}
        labelClassName="panel__label--prompt"
        value={input}
        inputRef={inputRef}
        placeholder={labels.inputPlaceholder}
        // The box holds the language this mode says it does, so its direction follows the mode.
        dir={textDirection(source)}
        onChange={setInput}
        actions={
          <InputActions
            hint={lastEvent === null ? null : INPUT_HINTS[lastEvent]}
            canCopy={input.length > 0}
            onPaste={handlePasteInput}
            onCopy={handleCopyInput}
            // Reading is the one mode whose input box holds the language being learned, so it is
            // the one mode whose input box can be read out loud.
            leading={
              express ? null : (
                <SpeakButton text={input} language={pair.learning} label="原文" />
              )
            }
          />
        }
      />

      <p className="assistant__meta">{input.length}/{MAX_INPUT_CHARS}</p>

      {express ? null : (
        <p className="note">
          在别的应用里选中文字后复制（Ctrl+C），再点「粘贴」。这个工具不读取其他窗口，也不监听剪贴板。
        </p>
      )}

      <TextPanel
        label={labels.output}
        value={output}
        readOnly
        // The answer can quote the other language, so the box follows its own content.
        dir="auto"
        placeholder={
          express && isMock ? 'Mock 模式：返回固定示例，不联网' : labels.outputPlaceholder
        }
        actions={
          // The answer is in the language being learned only when the user was the one writing:
          // the meaning handed back by Understand is in their own language and is not spoken.
          express ? <SpeakButton text={output} language={pair.learning} label="表达" /> : null
        }
      />

      <AnalysisPanel
        analysis={analysis}
        learningLanguage={pair.learning}
        // Learn files the sentence itself, in the same round trip, so what the panel shows is the
        // receipt: which sentence went in under which number, or why nothing did.
        learned={learned}
        learnFailure={learnFailure}
        onDismiss={handleDismissAnalysis}
      />

      <footer className="assistant__footer">
        <Toolbar
          direction={mode}
          tone={tone}
          busy={busy}
          copied={lastEvent === 'output-copied'}
          canCopy={output.length > 0}
          canRegenerate={canRegenerate}
          canLearn={canAnalyze}
          onToneChange={handleToneChange}
          onGenerate={handleRun}
          onCopy={handleCopy}
          onLearn={handleLearn}
          onRegenerate={regenerate}
          onCancel={cancel}
        />
        <StatusBar status={status} errorMessage={localError ?? errorMessage} direction={mode} />
      </footer>
    </div>
  )
}
