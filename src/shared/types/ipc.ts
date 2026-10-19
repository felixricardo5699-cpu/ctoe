import type { LanguageCode } from '../language/registry'
import type { BridgeLearnEvent, BridgeStatus } from './bridge'
import type {
  LearningAnalysis,
  PanelAnchor,
  PublicSettings,
  RecentTranslation,
  SavedSentence,
  SettingsPatch,
  ShortcutStatus,
  TaskKind,
  Tone,
  TranslationErrorCode,
  TranslationFailure,
  Vec2,
  WindowMode
} from './index'

/** Single source of truth for IPC channel names (no magic strings in the code). */
export const IPC = {
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  translateStart: 'translate:start',
  translateCancel: 'translate:cancel',
  translateDelta: 'translate:delta',
  translateDone: 'translate:done',
  translateFailed: 'translate:failed',
  clipboardWrite: 'clipboard:write',
  /** Reads the OS clipboard so the input box can import text in one click. */
  clipboardRead: 'clipboard:read',
  appInfo: 'app:info',
  windowExpand: 'window:expand',
  windowCollapse: 'window:collapse',
  windowToggle: 'window:toggle',
  /** Hides the window without quitting; the tray icon brings it back. */
  windowHide: 'window:hide',
  windowQuit: 'window:quit',
  /** The renderer asks for the current shape on mount, to close the startup race. */
  windowGetMode: 'window:get-mode',
  windowDragStart: 'window:drag-start',
  windowDragEnd: 'window:drag-end',
  /** main -> renderer: the window changed shape. */
  windowMode: 'window:mode',
  /** main -> renderer: open the settings page (tray / second launch). */
  uiOpenSettings: 'ui:open-settings',
  shortcutGet: 'shortcut:get',
  shortcutSet: 'shortcut:set',
  /** main -> renderer: registration failed or changed outside the settings page. */
  shortcutStatus: 'shortcut:status',
  /** My Learning: the sentences the user studied. Nothing is written until they ask to learn. */
  languageList: 'language:list',
  languageSave: 'language:save',
  languageRemove: 'language:remove',
  languageClear: 'language:clear',
  /** Recent translations: the short-lived list of what the user just translated. */
  recentList: 'recent:list',
  recentClear: 'recent:clear',
  /**
   * The browser bridge: whether the app is listening for an extension, which port it holds, and
   * the token the user pastes into it. Turning it on or off goes through settings:set like every
   * other switch, so the policy has exactly one way in.
   */
  bridgeStatus: 'bridge:get-status',
  /** Mints a new pairing token, which unpairs whatever extension was using the old one. */
  bridgeResetToken: 'bridge:reset-token',
  /** main -> renderer: the bridge changed state outside the settings page. */
  bridgeStatusChanged: 'bridge:status',
  /**
   * main -> renderer: a browser asked for a sentence to be learned, and it is now saved. The panel
   * shows it the way it shows anything else in My Learning - the record is a receipt, not a draft.
   */
  uiLearnSentence: 'ui:learn-sentence',
  /**
   * Opens the browser-extension folder that travels inside the installer, so the user can
   * point Chrome/Edge's「加载已解压的扩展程序」at it. The renderer cannot open a folder itself,
   * and this is the only thing the app does with the extension outside the bridge.
   */
  extensionOpenFolder: 'extension:open-folder',
  /**
   * Writes My Learning out as Word documents: one `.docx` per learning relation, asked for by the
   * user and saved into a folder they pick. The renderer never sees the documents, only where they
   * went.
   */
  languageExport: 'language:export',
  /**
   * Opens the folder the app keeps its own files in. Reading the path is not enough for the people
   * this exists for: they need the window in front of them.
   */
  dataOpenFolder: 'data:open-folder'
} as const

export interface TranslateStartPayload {
  requestId: string
  text: string
  tone: Tone
  context: string
  /** The language of `text`, and the language of `result` for the 'analyze' task. */
  sourceLanguage: LanguageCode
  /** The language the answer is produced in. */
  targetLanguage: LanguageCode
  /** 'express' generates the wording, 'analyze' writes the Learn note for it. */
  task: TaskKind
  /** The generated expression. Required by 'analyze', empty for 'express'. */
  result: string
  /**
   * Learn only: the sentence as the panel has it, both boxes. The main process files exactly what
   * the user was looking at, and never has to guess which box held what, because a 'result' is the
   * studied sentence from Say it and the meaning from Understand.
   */
  sentence?: TranslateSentence
}

/**
 * The two boxes of the panel, as the user saw them, plus which way round they went. Sent with
 * every 'analyze' request, because asking for the analysis is what files the sentence: the main
 * process has to know what the user was looking at, and it must not guess which box held what.
 *
 * The direction here is the moment's own - Say it goes native -> learning, Understand walks the
 * same pair back - not the direction of the analyze request. A Learn request is always asked the
 * same way round (native in, learning out), so its own pair names the language being studied while
 * these two say which way this particular moment went.
 */
export interface TranslateSentence {
  /** What the user brought: what they wanted to say, or the text they were reading. */
  originalText: string
  /** What came back in the other language. */
  translatedText: string
  /** The language of the text the user brought. */
  sourceLanguage: LanguageCode
  /** The language of the answer the panel showed next to it. */
  targetLanguage: LanguageCode
}

/**
 * What came back from asking the app to reveal the bundled browser extension.
 *
 * `folder` is the absolute path either way, so the page can still tell the user where to look
 * when opening it failed - and `message` is empty exactly when the folder was opened.
 */
export interface ExtensionFolderResult {
  ok: boolean
  folder: string | null
  message: string
}

/**
 * What came back from exporting My Learning.
 *
 * `files` is every document written, in the order they were produced, and `folder` is where they
 * landed - the page shows both, because the whole point of the feature is a file the user can open
 * and print. A cancelled folder picker is `ok: false` with no files rather than an error: nothing
 * went wrong, the user changed their mind.
 */
export interface LearningExportResult {
  ok: boolean
  folder: string | null
  files: string[]
  message: string
}

/** What came back from opening the app's own data folder. */
export interface DataFolderResult {
  ok: boolean
  folder: string | null
  message: string
}

export interface TranslateDelta {
  requestId: string
  /** Generate: the next slice of the answer, in whatever language it is being written. */
  text: string
  /**
   * Learn only: the points that have finished arriving so far. The answer is JSON, so the
   * main process parses on the way through and the renderer never sees half-written braces.
   */
  analysis?: LearningAnalysis | null
}

export interface TranslateDone {
  requestId: string
  text: string
  /** Learn only: the structured coaching result. `text` stays empty for that task. */
  analysis?: LearningAnalysis | null
  /**
   * Learn only: the record the study pass wrote. Asking for the analysis is what files the
   * sentence, so this is the receipt - and null means the note is on screen but nothing was kept,
   * which the panel says out loud rather than pretending.
   */
  learned?: SavedSentence | null
  /** Learn only: why nothing was filed. A code, turned into words by the renderer. */
  learnFailure?: TranslationErrorCode | null
}

export interface TranslateFailed {
  requestId: string
  failure: TranslationFailure
}

export interface WindowModePayload {
  mode: WindowMode
  /** Where the panel sits relative to the ball, so the animation starts from the ball. */
  anchor: PanelAnchor
}

export interface AppInfo {
  version: string
  platform: string
  /** Absolute path of the local config file, shown in settings for transparency. */
  configPath: string
}

export type {
  BridgeLearnEvent,
  BridgeStatus,
  PublicSettings,
  RecentTranslation,
  SavedSentence,
  SettingsPatch,
  ShortcutStatus,
  Vec2
}
