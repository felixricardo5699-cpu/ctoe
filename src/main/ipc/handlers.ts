import { app, ipcMain, type WebContents } from 'electron'
import { MAX_INPUT_CHARS } from '@shared/config/defaults'
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  isLanguageCode,
  resolveLanguageCode,
  type LanguageCode
} from '@shared/language/registry'
import {
  DEFAULT_TASK,
  DEFAULT_TONE,
  KNOWLEDGE_FIELD_LIMITS,
  KNOWLEDGE_POINT_SAFETY_LIMIT,
  isKnowledgeImportance,
  isLearningKind,
  isBrowserBridgePolicy,
  isProviderKind,
  isRecentPolicy,
  isTaskKind,
  isTone,
  type KnowledgeImportance,
  type LearningAnalysis,
  type LearningItem,
  type SavedSentence,
  type SavedSentenceDraft,
  type SavedSentenceRef,
  type SettingsPatch,
  type ShortcutStatus,
  type TranslationErrorCode,
  type TranslationFailure,
  type TranslationRequest
} from '@shared/types'
import type { BridgeStatus } from '@shared/types/bridge'
import { exportDocuments, type ExportDocument } from '@shared/learning/exportDocument'
import {
  IPC,
  type DataFolderResult,
  type ExtensionFolderResult,
  type LearningExportResult,
  type TranslateDelta,
  type TranslateDone,
  type TranslateFailed,
  type TranslateSentence,
  type TranslateStartPayload,
  type WindowModePayload
} from '@shared/types/ipc'
import {
  parseLearningAnalysis,
  parseLearningAnalysisPartial,
  parseUnderstanding,
  readStreamedMeaning
} from '@shared/learning/parse'
import { SentenceIdExhaustedError, isSentenceId } from '@shared/language/sentenceId'
import { isBlank, normalizeText, stripWrappingQuotes } from '@shared/utils/text'
import { ProviderError, summarizeDetail } from '../services/ai/errors'
import { createProvider } from '../services/ai/createProvider'
import { copyToClipboard, readFromClipboard } from '../services/clipboard/clipboardService'
import type { ConfigStore } from '../services/config/configStore'
import type { LanguageStore } from '../services/language/languageStore'
import type { RecentStore, RecentTranslationDraft } from '../services/recent/recentStore'
import { applyLaunchAtLogin } from '../services/startup/loginItem'

/**
 * Narrow views of the window/shortcut services. Keeping them as interfaces (instead
 * of importing the classes) means the IPC layer can be tested without Electron.
 */
export interface WindowController {
  expand(): void
  /** main -> renderer: a message the UI reacts to rather than one it asked for. */
  send(channel: string, payload: unknown): void
  collapse(): void
  hide(): void
  toggle(): void
  startDrag(): void
  endDrag(): void
  windowMode(): WindowModePayload
  setFloatingBall(enabled: boolean): void
}

export interface ShortcutController {
  status(): ShortcutStatus
  set(accelerator: string): ShortcutStatus
}

/**
 * The browser bridge, as the settings page sees it. Opening and closing the port is not here: the
 * policy is stored like every other setting, so switching the bridge on is a settings patch and
 * the service is told to catch up (see IPC.settingsSet).
 */
export interface BridgeController {
  status(): BridgeStatus
  resetToken(): BridgeStatus
  applyPolicy(): Promise<void>
}

/**
 * The browser extension that travels inside the installer.
 *
 * Nothing here installs anything: Chrome and Edge do not let an outside program add an
 * extension, and that is a good thing. All this can do is say where the unpacked copy is and
 * open it, so the user own「加载已解压的扩展程序」has something to point at.
 */
export interface ExtensionController {
  /** Absolute path of the unpacked extension, or null when this build does not carry one. */
  folder(): string | null
  /** Opens that folder in the OS file manager; '' on success, else why it failed. */
  reveal(folder: string): Promise<string>
}

/**
 * The parts of the operating system the learning library needs: where the app keeps its own files,
 * and how a document leaves the app.
 *
 * Injected rather than imported for the usual reason - the export can then be driven by a test
 * without a folder picker appearing, and the IPC layer keeps saying what happened instead of how.
 */
export interface FilesController {
  /** Absolute path of the folder holding `config.json` and `learned.json`. */
  dataFolder(): string
  /** The folder an export defaults to. Created on demand; never fails. */
  exportFolder(): string
  /** Opens a folder in the OS file manager; '' on success, otherwise why it failed. */
  openFolder(folder: string): Promise<string>
  /** Asks the user for a folder; null when they cancelled. */
  chooseFolder(defaultFolder: string): Promise<string | null>
  /** Writes one document per entry and returns their absolute paths. */
  writeDocuments(folder: string, documents: readonly ExportDocument[]): Promise<string[]>
  /** Selects a written file in the OS file manager. */
  revealFile(file: string): void
}

export interface IpcDeps {
  config: ConfigStore
  windows: WindowController
  shortcuts: ShortcutController
  language: LanguageStore
  recent: RecentStore
  bridge: BridgeController
  extension: ExtensionController
  files: FilesController
}

export interface IpcHandlers {
  /** Aborts every in-flight translation (window closed or app quitting). */
  cancelAll(): void
}

/**
 * Where a run's events go.
 *
 * Learn used to be reachable from exactly one place - the panel - so its events could only mean
 * "send this to the window". The browser bridge files the same kind of sentence without the panel
 * having asked, so the events are now addressed to a sink and the window is just the sink the IPC
 * layer happens to hand over. That keeps one implementation of the pipeline, which is what makes
 * the two entry points behave identically.
 */
export interface TranslationSink {
  delta(payload: TranslateDelta): void
  done(payload: TranslateDone): void
  failed(payload: TranslateFailed): void
}

/** What a run needs from the app. Both entry points supply the same three stores. */
export interface TranslationDeps {
  config: ConfigStore
  language: LanguageStore
  recent: RecentStore
}

export function registerIpcHandlers(deps: IpcDeps): IpcHandlers {
  const { config, windows, shortcuts, language, recent, bridge, extension, files } = deps
  const stores: TranslationDeps = { config, language, recent }
  const active = new Map<string, AbortController>()

  const cancel = (requestId: string): void => {
    const controller = active.get(requestId)
    if (controller === undefined) return
    active.delete(requestId)
    controller.abort(new Error('cancelled by user'))
  }

  ipcMain.handle(IPC.settingsGet, () => config.readPublicSettings())

  ipcMain.handle(IPC.settingsSet, (_event, patch: unknown) => {
    const before = config.readPublicSettings()
    const after = config.updateSettings(sanitizePatch(patch))
    // Settings can change the window shape, the OS login item and whether a port is open, so act
    // on the diff. The bridge is told to catch up rather than switched here, so the stored policy
    // stays the one answer to whether it should be listening.
    if (before.floatingBall !== after.floatingBall) windows.setFloatingBall(after.floatingBall)
    if (before.launchAtLogin !== after.launchAtLogin) applyLaunchAtLogin(after.launchAtLogin)
    if (before.browserBridgePolicy !== after.browserBridgePolicy) {
      // Switching it on is what mints the token, so the page is told once that has happened -
      // otherwise the field the user is meant to copy it from would still read as empty.
      //
      // applyPolicy() rejects when every port in the range is already taken. That is not a failed
      // save - the policy is stored either way - it is "cannot listen right now", which the status
      // already says through listening=false. So the refusal is swallowed and the status is sent
      // regardless: letting it escape would strand the open page on a stale switch, and would leave
      // an unhandled rejection behind in the main process.
      void bridge
        .applyPolicy()
        .catch(() => undefined)
        .then(() => {
          windows.send(IPC.bridgeStatusChanged, bridge.status())
        })
    }
    return after
  })

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    platform: process.platform,
    configPath: config.path
  }))

  ipcMain.handle(IPC.clipboardWrite, (_event, text: unknown) => copyToClipboard(typeof text === 'string' ? text : ''))
  ipcMain.handle(IPC.clipboardRead, () => readFromClipboard())

  ipcMain.handle(IPC.windowExpand, () => {
    windows.expand()
  })
  ipcMain.handle(IPC.windowCollapse, () => {
    windows.collapse()
  })
  ipcMain.handle(IPC.windowToggle, () => {
    windows.toggle()
  })
  ipcMain.handle(IPC.windowHide, () => {
    windows.hide()
  })
  ipcMain.handle(IPC.windowQuit, () => {
    app.quit()
  })
  ipcMain.handle(IPC.windowGetMode, () => windows.windowMode())
  ipcMain.handle(IPC.windowDragStart, () => {
    windows.startDrag()
  })
  ipcMain.handle(IPC.windowDragEnd, () => {
    windows.endDrag()
  })

  ipcMain.handle(IPC.shortcutGet, () => shortcuts.status())
  ipcMain.handle(IPC.shortcutSet, (_event, accelerator: unknown) =>
    shortcuts.set(typeof accelerator === 'string' ? accelerator : '')
  )

  ipcMain.handle(IPC.languageList, () => language.list())

  ipcMain.handle(IPC.languageSave, (_event, draft: unknown) => {
    const sentence = asSavedSentenceDraft(draft)
    if (sentence === null) return language.list()
    try {
      return language.save(sentence)
    } catch (error) {
      // A pair that has handed out its last id. The code is what crosses to the renderer, which
      // is the layer that knows how to say it in the user's own words.
      if (error instanceof SentenceIdExhaustedError) throw new Error(error.code)
      throw error
    }
  })

  // Deleting is deleting: the sentence is dropped and the file is rewritten without it.
  ipcMain.handle(IPC.languageRemove, (_event, ref: unknown) => {
    const target = asSentenceRef(ref)
    return target === null ? language.list() : language.remove(target)
  })

  ipcMain.handle(IPC.languageClear, () => language.clear())

  // Reading and clearing only: a row is written by the translation that produced it, so the
  // renderer has no way to put anything into this list - or to fake a translation into it.
  ipcMain.handle(IPC.recentList, () => recent.list())
  ipcMain.handle(IPC.recentClear, () => recent.clear())

  // The token is minted by the service the first time the bridge is switched on, so the status
  // carries whatever it holds - including the empty string while the feature has never been used.
  ipcMain.handle(IPC.bridgeStatus, () => bridge.status())
  ipcMain.handle(IPC.bridgeResetToken, () => {
    const status = bridge.resetToken()
    // The open settings page is showing the old token, so it is told rather than left stale.
    windows.send(IPC.bridgeStatusChanged, status)
    return status
  })

  ipcMain.handle(IPC.extensionOpenFolder, async (): Promise<ExtensionFolderResult> => {
    const folder = extension.folder()
    if (folder === null) {
      return { ok: false, folder: null, message: '这个版本没有带上浏览器扩展，请到项目目录的 extension 里找。' }
    }
    const failure = await extension.reveal(folder)
    return failure === '' ? { ok: true, folder, message: '' } : { ok: false, folder, message: failure }
  })

  /**
   * My Learning as Word documents.
   *
   * The reading and the layout happen here, before the picker opens, so the user is only asked
   * where to put files that already exist in memory. Three outcomes, and each says what happened:
   * nothing to export, the user cancelled (not an error), and the write itself.
   */
  ipcMain.handle(IPC.languageExport, async (): Promise<LearningExportResult> => {
    const sentences = language.list()
    if (sentences.length === 0) {
      return { ok: false, folder: null, files: [], message: '还没有学习记录，先点一次 Learn。' }
    }
    const documents = exportDocuments(sentences, new Date())
    const folder = await files.chooseFolder(files.exportFolder())
    if (folder === null) return { ok: false, folder: null, files: [], message: '已取消导出。' }
    try {
      const written = await files.writeDocuments(folder, documents)
      // Showing the first file is the answer to "where did it go" - the folder alone would still
      // leave someone scrolling a directory full of other people's files.
      if (written.length > 0) files.revealFile(written[0] ?? '')
      return { ok: true, folder, files: written, message: '' }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, folder: null, files: [], message: '导出失败：' + reason }
    }
  })

  ipcMain.handle(IPC.dataOpenFolder, async (): Promise<DataFolderResult> => {
    const folder = files.dataFolder()
    const failure = await files.openFolder(folder)
    return failure === '' ? { ok: true, folder, message: '' } : { ok: false, folder, message: failure }
  })

  ipcMain.handle(IPC.translateCancel, (_event, requestId: unknown) => {
    if (typeof requestId === 'string') cancel(requestId)
  })

  ipcMain.handle(IPC.translateStart, async (event, payload: unknown) => {
    const request = asTranslatePayload(payload)
    if (request === null) return
    // A repeated id means the renderer restarted the same request: drop the old one.
    cancel(request.requestId)
    const controller = new AbortController()
    active.set(request.requestId, controller)
    try {
      await runTranslation(stores, senderSink(event.sender), request, controller.signal)
    } finally {
      active.delete(request.requestId)
    }
  })

  return {
    cancelAll: (): void => {
      for (const requestId of [...active.keys()]) cancel(requestId)
    }
  }
}

/**
 * One request, from validation to answer.
 *
 * It reports through the sink and returns the 'done' payload it emitted - or null when it failed,
 * in which case the failure has already gone to the sink. The return value is what the browser
 * bridge reads: it has no panel to show the answer in, so it needs the finished result in hand to
 * carry on with (see services/bridge/learnRequest.ts).
 */
export async function runTranslation(
  deps: TranslationDeps,
  sink: TranslationSink,
  payload: TranslateStartPayload,
  signal: AbortSignal
): Promise<TranslateDone | null> {
  const { config, language, recent } = deps
  const { requestId } = payload
  try {
    const text = normalizeText(payload.text)
    if (isBlank(text)) throw new ProviderError('missing-input', 'blank input')
    if (text.length > MAX_INPUT_CHARS) {
      throw new ProviderError('input-too-long', 'input length ' + text.length)
    }
    // Learn reads the expression the user already has; without it there is nothing to coach.
    const expression = payload.result.trim()
    if (payload.task === 'analyze' && isBlank(expression)) {
      throw new ProviderError('missing-result', 'analyze without a generated result')
    }

    const provider = createProvider({
      kind: config.readPublicSettings().providerKind,
      settings: config.readProviderSettings()
    })

    const request: TranslationRequest = {
      task: payload.task,
      text,
      tone: payload.tone,
      context: payload.context,
      sourceLanguage: payload.sourceLanguage,
      targetLanguage: payload.targetLanguage,
      result: expression
    }

    // Learn and Understand are both JSON answers, so raw deltas would only ever show
    // half-written braces. The stream is parsed on the way through instead: Learn emits the
    // points that have closed, Understand emits the meaning so far (in the user's language)
    // plus those points.
    let jsonBuffer = ''
    let emittedPoints = 0
    let emittedMeaning = ''

    const result = await provider.translate(request, {
      signal,
      onDelta: (chunk: string) => {
        if (payload.task === 'express') {
          sink.delta({ requestId, text: chunk })
          return
        }
        jsonBuffer += chunk
        const items = parseLearningAnalysisPartial(jsonBuffer)?.items ?? []
        // An Understand answer leads with the meaning of the whole text, and that is the
        // main result, so it streams as a growing snapshot the panel can replace outright.
        const meaning = payload.task === 'understand' ? readStreamedMeaning(jsonBuffer) : ''
        if (items.length <= emittedPoints && meaning === emittedMeaning) return
        emittedPoints = items.length
        emittedMeaning = meaning
        sink.delta({
          requestId,
          text: meaning,
          analysis: items.length === 0 ? null : { items }
        })
      }
    })

    if (payload.task === 'analyze') {
      const analysis = parseLearningAnalysis(result)
      // Nothing usable came back, so the user gets a retry instead of half a lesson.
      // The model's answer is never logged: it is derived from the user's own text.
      if (analysis === null) {
        throw new ProviderError('malformed-response', 'learn answer was not usable JSON')
      }
      // Asking for the analysis is the study act, so the sentence is filed right here: one round
      // trip, and the renderer cannot forget to keep it. A write that could not land still gets its
      // analysis on screen with the reason attached - the answer is already paid for.
      const learned = storeLearned(language, payload, analysis)
      const done: TranslateDone = {
        requestId,
        text: '',
        analysis,
        learned: learned.record,
        learnFailure: learned.failure
      }
      sink.done(done)
      return done
    }

    if (payload.task === 'understand') {
      const understanding = parseUnderstanding(result)
      // Same rule as Learn: an answer nobody can read is a retry, not half a screen.
      if (understanding === null) {
        throw new ProviderError('malformed-response', 'understand answer was not usable JSON')
      }
      // The meaning is the answer and the points ride along in the same request on purpose:
      // reading a sentence should never cost a second round trip.
      // The meaning is the answer, so it is what the recent list would remember: the user
      // pasted a line they were reading and got this back.
      storeRecent(recent, config, {
        sourceLanguage: payload.sourceLanguage,
        targetLanguage: payload.targetLanguage,
        // Reading is the relation walked back, so the side being studied is what came in.
        learningLanguage: payload.sourceLanguage,
        tone: payload.tone,
        sourceText: text,
        targetText: understanding.meaning
      })
      const done: TranslateDone = {
        requestId,
        text: understanding.meaning,
        analysis: understanding.items.length === 0 ? null : { items: understanding.items }
      }
      sink.done(done)
      return done
    }

    const finalText = stripWrappingQuotes(result)
    storeRecent(recent, config, {
      sourceLanguage: payload.sourceLanguage,
      targetLanguage: payload.targetLanguage,
      // Writing goes native -> learning, so the studied side is the answer.
      learningLanguage: payload.targetLanguage,
      tone: payload.tone,
      sourceText: text,
      targetText: finalText
    })
    const done: TranslateDone = { requestId, text: finalText }
    sink.done(done)
    return done
  } catch (error) {
    sink.failed({ requestId, failure: toFailure(error) })
    return null
  }
}

/** The window as a sink: one event is one IPC message, and a closed window is not an error. */
function senderSink(sender: WebContents): TranslationSink {
  return {
    delta: (payload): void => send(sender, IPC.translateDelta, payload),
    done: (payload): void => send(sender, IPC.translateDone, payload),
    failed: (payload): void => send(sender, IPC.translateFailed, payload)
  }
}

/**
 * Remembers a finished translation, when the user asked for that.
 *
 * Best effort on purpose: the answer is already on screen, and a convenience list of past work
 * must never be the reason a translation fails. Nothing is written unless the policy is 'on',
 * so the shipped behaviour really is "nothing about what you typed is kept".
 *
 * A row with the same language on both sides is not a translation, so it is not one to keep.
 */
function storeRecent(
  recent: RecentStore,
  config: ConfigStore,
  draft: RecentTranslationDraft
): void {
  if (draft.sourceLanguage === draft.targetLanguage) return
  if (config.readPublicSettings().recentPolicy !== 'on') return
  try {
    recent.record(draft)
  } catch {
    // The translation the user asked for has already been delivered; this list can wait.
  }
}

/** What a study pass did: the record it wrote, or the reason there is none. */
interface LearnWrite {
  record: SavedSentence | null
  failure: TranslationErrorCode | null
}

/**
 * Files the sentence Learn just analysed, and reports it in the terms the renderer shows.
 *
 * The studied side is the request's target: an analyze request is always about the language being
 * learned (see languageContext), because the coaching answer is written in the user's own language
 * about the other one. The direction is the panel's own, so the record remembers which way this
 * moment went even after the user moves on to another language - and the store reads the relation
 * (native + learning) off those three fields, so both directions land on one shelf and share one
 * id sequence.
 */
function storeLearned(
  language: LanguageStore,
  payload: TranslateStartPayload,
  analysis: LearningAnalysis
): LearnWrite {
  const sentence = payload.sentence
  if (sentence === undefined) return { record: null, failure: 'missing-sentence' }
  try {
    return {
      record: language.learn({
        originalText: sentence.originalText,
        translatedText: sentence.translatedText,
        tone: payload.tone,
        sourceLanguage: sentence.sourceLanguage,
        targetLanguage: sentence.targetLanguage,
        learningLanguage: payload.targetLanguage,
        knowledgePoints: analysis.items
      }),
      failure: null
    }
  } catch (error) {
    // A relation out of ids is the one failure a person can act on; anything else is a write that
    // did not land and can simply be asked for again.
    return {
      record: null,
      failure:
        error instanceof SentenceIdExhaustedError ? 'language-pair-id-exhausted' : 'storage-failed'
    }
  }
}

function send(sender: WebContents, channel: string, payload: unknown): void {
  if (sender.isDestroyed()) return
  sender.send(channel, payload)
}

function toFailure(error: unknown): TranslationFailure {
  if (error instanceof ProviderError) return { code: error.code, detail: error.detail }
  if (error instanceof Error) return { code: 'unknown', detail: summarizeDetail(error.message) }
  return { code: 'unknown', detail: 'unexpected error' }
}

/**
 * Same trust boundary as a translation payload: My Learning is the user's own data, but the
 * renderer is still untrusted. The main process owns the sentence id, both timestamps and every
 * point id; anything the UI sends for those is ignored, and points that cannot be read are
 * dropped rather than stored.
 *
 * A sentence needs one of its two lines. It does not need a point: a sentence the user found
 * worth keeping is worth keeping on its own.
 */
function asSavedSentenceDraft(payload: unknown): SavedSentenceDraft | null {
  if (typeof payload !== 'object' || payload === null) return null
  const source = payload as Record<string, unknown>
  const originalText = readField(source.originalText)
  const translatedText = readField(source.translatedText)
  if (originalText.length === 0 && translatedText.length === 0) return null
  const sourceLanguage = resolveLanguageCode(source.sourceLanguage, DEFAULT_NATIVE_LANGUAGE)
  const targetLanguage = resolveLanguageCode(source.targetLanguage, DEFAULT_LEARNING_LANGUAGE)
  // A direction that goes nowhere says nothing about what was being learned, so it is not a moment
  // worth keeping. The panel cannot produce one - it walks the pair one way or the other.
  if (sourceLanguage === targetLanguage) return null
  return {
    originalText,
    translatedText,
    tone: isTone(source.tone) ? source.tone : DEFAULT_TONE,
    // Which way this sentence went, and which side of it is the one being studied. Unreadable
    // values fall back rather than being trusted, exactly like every other field here; the
    // relation the sentence belongs to is read off these three by the store, in one place.
    sourceLanguage,
    targetLanguage,
    // Which side of that pair the sentence teaches, which is what My Learning groups on. When
    // it is missing the answer side is the safe reading: that is what Say it produces.
    learningLanguage: resolveLanguageCode(source.learningLanguage, targetLanguage),
    knowledgePoints: asKnowledgePoints(source.knowledgePoints)
  }
}

/**
 * The points of one sentence, as many as the model found worth teaching. There is no product
 * cap: the ceiling below only stops a runaway answer (or a hostile renderer) from filling one
 * note with hundreds of lines. Points that cannot be read are dropped, and over-long fields are
 * cut rather than thrown away, because an over-long field is still the user's own text.
 */
function asKnowledgePoints(value: unknown): LearningItem[] {
  if (!Array.isArray(value)) return []
  const points: LearningItem[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const source = entry as Record<string, unknown>
    const expression = readField(source.expression).slice(0, KNOWLEDGE_FIELD_LIMITS.text)
    const meaning = readField(source.meaning).slice(0, KNOWLEDGE_FIELD_LIMITS.meaning)
    if (expression.length === 0 || meaning.length === 0) continue
    points.push({
      kind: isLearningKind(source.kind) ? source.kind : 'expression',
      expression,
      meaning,
      why: readField(source.why).slice(0, KNOWLEDGE_FIELD_LIMITS.why),
      example: readField(source.example).slice(0, KNOWLEDGE_FIELD_LIMITS.example),
      exampleTranslation: readField(source.exampleTranslation).slice(
        0,
        KNOWLEDGE_FIELD_LIMITS.exampleTranslation
      ),
      // An ordering hint only: a point the model did not rank is still kept, in the middle.
      importance: readImportance(source.importance)
    })
    if (points.length === KNOWLEDGE_POINT_SAFETY_LIMIT) break
  }
  return points
}

function readImportance(value: unknown): KnowledgeImportance | undefined {
  return isKnowledgeImportance(value) ? value : undefined
}

/**
 * An id is only unique inside one learning relation, so a delete has to name the relation. A
 * request that names neither a real relation nor an id is not something to act on, and dropping it
 * is safer than picking a bucket to delete from.
 */
function asSentenceRef(payload: unknown): SavedSentenceRef | null {
  if (typeof payload !== 'object' || payload === null) return null
  const source = payload as Record<string, unknown>
  if (!isSentenceId(source.id)) return null
  if (!isLanguageCode(source.nativeLanguage)) return null
  if (!isLanguageCode(source.learningLanguage)) return null
  if (source.nativeLanguage === source.learningLanguage) return null
  return {
    id: source.id,
    nativeLanguage: source.nativeLanguage,
    learningLanguage: source.learningLanguage
  }
}

function readField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Renderer input is untrusted: coerce everything to known-good shapes. */
function asTranslatePayload(payload: unknown): TranslateStartPayload | null {
  if (typeof payload !== 'object' || payload === null) return null
  const source = payload as Record<string, unknown>
  const requestId = source.requestId
  const text = source.text
  if (typeof requestId !== 'string' || requestId.length === 0) return null
  if (typeof text !== 'string') return null
  const sourceLanguage = resolveLanguageCode(source.sourceLanguage, DEFAULT_NATIVE_LANGUAGE)
  const targetLanguage = resolveLanguageCode(source.targetLanguage, DEFAULT_LEARNING_LANGUAGE)
  return {
    requestId,
    text,
    context: typeof source.context === 'string' ? source.context : '',
    tone: isTone(source.tone) ? source.tone : DEFAULT_TONE,
    sourceLanguage,
    targetLanguage,
    task: isTaskKind(source.task) ? source.task : DEFAULT_TASK,
    result: typeof source.result === 'string' ? source.result : '',
    sentence: asTranslateSentence(source.sentence, sourceLanguage, targetLanguage)
  }
}

/**
 * Learn only: the two boxes as the user saw them, and which way round they went. Both empty is the
 * same as not sending the field at all, and the main process never guesses which box held the
 * user's own words - the 'result' is the studied sentence from Say it and the meaning from
 * Understand, so only the panel knows.
 *
 * The direction travels with the sentence because a moment is filed the way it happened, and the
 * request cannot say it: an analyze request is always asked native -> learning, whichever mode
 * asked for it. A direction that is unreadable, or that goes nowhere (the same language on both
 * sides), is dropped - the Learn note then reaches the screen without a sentence being filed.
 */
function asTranslateSentence(
  value: unknown,
  fallbackSource: LanguageCode,
  fallbackTarget: LanguageCode
): TranslateSentence | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  const originalText = readField(source.originalText)
  const translatedText = readField(source.translatedText)
  if (originalText.length === 0 && translatedText.length === 0) return undefined
  const sourceLanguage = resolveLanguageCode(source.sourceLanguage, fallbackSource)
  const targetLanguage = resolveLanguageCode(source.targetLanguage, fallbackTarget)
  if (sourceLanguage === targetLanguage) return undefined
  return { originalText, translatedText, sourceLanguage, targetLanguage }
}

function sanitizePatch(payload: unknown): SettingsPatch {
  if (typeof payload !== 'object' || payload === null) return {}
  const source = payload as Record<string, unknown>
  const patch: SettingsPatch = {}
  if (typeof source.baseUrl === 'string') patch.baseUrl = source.baseUrl
  if (typeof source.model === 'string') patch.model = source.model
  if (isTone(source.tone)) patch.tone = source.tone
  if (isProviderKind(source.providerKind)) patch.providerKind = source.providerKind
  if (typeof source.apiKey === 'string') patch.apiKey = source.apiKey
  if (typeof source.floatingBall === 'boolean') patch.floatingBall = source.floatingBall
  if (isLanguageCode(source.nativeLanguage)) patch.nativeLanguage = source.nativeLanguage
  if (isLanguageCode(source.learningLanguage)) patch.learningLanguage = source.learningLanguage
  if (typeof source.launchAtLogin === 'boolean') patch.launchAtLogin = source.launchAtLogin
  if (isRecentPolicy(source.recentPolicy)) patch.recentPolicy = source.recentPolicy
  if (isBrowserBridgePolicy(source.browserBridgePolicy)) {
    patch.browserBridgePolicy = source.browserBridgePolicy
  }
  return patch
}
