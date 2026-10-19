import type {
  PublicSettings,
  RecentTranslation,
  SavedSentence,
  SavedSentenceDraft,
  SavedSentenceRef,
  SettingsPatch,
  ShortcutStatus,
  TranslationFailure
} from './index'
import type { BridgeLearnEvent, BridgeStatus } from './bridge'
import type {
  AppInfo,
  DataFolderResult,
  ExtensionFolderResult,
  LearningExportResult,
  TranslateDelta,
  TranslateDone,
  TranslateStartPayload,
  WindowModePayload
} from './ipc'

export type Unsubscribe = () => void

/**
 * The only surface the UI is allowed to talk to. Electron/Node specifics stay
 * behind this interface so the renderer never touches the network or the disk.
 */
export interface AssistantApi {
  getSettings(): Promise<PublicSettings>
  saveSettings(patch: SettingsPatch): Promise<PublicSettings>
  getAppInfo(): Promise<AppInfo>
  copyText(text: string): Promise<boolean>
  /** Current clipboard text (empty string when it holds nothing textual). */
  readText(): Promise<string>
  /** One shape for a request, defined next to the IPC channels that carry it. */
  startTranslation(payload: TranslateStartPayload): Promise<void>
  cancelTranslation(requestId: string): Promise<void>
  onDelta(listener: (payload: TranslateDelta) => void): Unsubscribe
  onDone(listener: (payload: TranslateDone) => void): Unsubscribe
  onFailed(listener: (payload: { requestId: string; failure: TranslationFailure }) => void): Unsubscribe

  /**
   * Ball <-> panel. The main process owns the geometry; the UI only asks for a shape.
   * Hiding the panel puts the window away without quitting - the tray icon or the
   * global shortcut brings it back.
   */
  expandPanel(): Promise<void>
  collapsePanel(): Promise<void>
  togglePanel(): Promise<void>
  hidePanel(): Promise<void>
  quitApp(): Promise<void>
  getWindowMode(): Promise<WindowModePayload>
  onWindowMode(listener: (payload: WindowModePayload) => void): Unsubscribe
  onOpenSettings(listener: () => void): Unsubscribe

  /**
   * Dragging the ball. The main process follows the cursor and moves the window, so
   * the UI only reports press and release; a press that never moved opens the panel.
   */
  startBallDrag(): Promise<void>
  endBallDrag(): Promise<void>

  getShortcutStatus(): Promise<ShortcutStatus>
  setShortcut(accelerator: string): Promise<ShortcutStatus>
  onShortcutStatus(listener: (status: ShortcutStatus) => void): Unsubscribe

  /**
   * My Learning: the local sentences the user studied, each with the points found in it. Every
   * one of these is user-initiated - asking for a Learn note is what writes, and the app never
   * reads or records anything on its own - and nothing ever leaves this machine. Deleting one
   * deletes the sentence and its points together.
   */
  listSavedSentences(): Promise<SavedSentence[]>
  saveSentence(sentence: SavedSentenceDraft): Promise<SavedSentence[]>
  removeSentence(ref: SavedSentenceRef): Promise<SavedSentence[]>
  clearSentences(): Promise<SavedSentence[]>

  /**
   * Recent translations - a short-lived list, kept only while the user asks for it. There is no
   * write here on purpose: a translation is remembered by the main process at the moment it is
   * delivered, so the renderer cannot add a row of its own, and nothing is kept at all unless
   * the user turned the list on in settings.
   */
  listRecentTranslations(): Promise<RecentTranslation[]>
  clearRecentTranslations(): Promise<RecentTranslation[]>

  /**
   * The browser bridge. Reading the status is what the settings page draws; there is no "set
   * policy" here on purpose, because switching it on or off is a setting like any other and goes
   * through saveSettings. Resetting the token is its own call because it is an action, not a value.
   */
  getBridgeStatus(): Promise<BridgeStatus>
  resetBridgeToken(): Promise<BridgeStatus>
  /** Fires when the bridge starts, stops or is reached while the settings page is open. */
  onBridgeStatus(listener: (status: BridgeStatus) => void): Unsubscribe
  /**
   * A sentence a browser asked for, already saved. It arrives when the app did not ask for it, so
   * the panel reacts rather than drives: showing it is the difference between a background write
   * and a lesson.
   */
  onLearnSentence(listener: (event: BridgeLearnEvent) => void): Unsubscribe

  /**
   * Opens the folder holding the browser extension that ships with this app, so the user can
   * load it once. Nothing is installed from here - Chrome and Edge do not allow that - so all
   * this does is put the folder in front of them and say where it is.
   */
  openExtensionFolder(): Promise<ExtensionFolderResult>

  /**
   * My Learning as something printable. One Word document per language relation, written into a
   * folder the user picks; the answer names the folder and the files so the page can say where
   * they went. Nothing is sent anywhere and the stored records are only read.
   */
  exportLearning(): Promise<LearningExportResult>

  /**
   * Opens the app's own data folder - the one holding `config.json` and `learned.json`. Most
   * people never need a path; the ones who do need the window, not the string.
   */
  openDataFolder(): Promise<DataFolderResult>
}
