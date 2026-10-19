import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type {
  PublicSettings,
  RecentTranslation,
  SavedSentence,
  SavedSentenceDraft,
  SavedSentenceRef,
  SettingsPatch,
  ShortcutStatus,
  TranslationFailure
} from '@shared/types'
import type { BridgeLearnEvent, BridgeStatus } from '@shared/types/bridge'
import type { AssistantApi, Unsubscribe } from '@shared/types/api'
import {
  IPC,
  type AppInfo,
  type DataFolderResult,
  type ExtensionFolderResult,
  type LearningExportResult,
  type TranslateDelta,
  type TranslateDone,
  type TranslateStartPayload,
  type WindowModePayload
} from '@shared/types/ipc'

/**
 * The renderer gets exactly this object and nothing else: no node, no ipcRenderer,
 * no way to reach the API key.
 */
function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const wrapped = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, wrapped)
  return () => {
    ipcRenderer.off(channel, wrapped)
  }
}

const api: AssistantApi = {
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet) as Promise<PublicSettings>,
  saveSettings: (patch: SettingsPatch) => ipcRenderer.invoke(IPC.settingsSet, patch) as Promise<PublicSettings>,
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  copyText: (text: string) => ipcRenderer.invoke(IPC.clipboardWrite, text) as Promise<boolean>,
  readText: () => ipcRenderer.invoke(IPC.clipboardRead) as Promise<string>,
  startTranslation: (payload: TranslateStartPayload) => ipcRenderer.invoke(IPC.translateStart, payload) as Promise<void>,
  cancelTranslation: (requestId: string) => ipcRenderer.invoke(IPC.translateCancel, requestId) as Promise<void>,
  onDelta: (listener: (payload: TranslateDelta) => void) => subscribe<TranslateDelta>(IPC.translateDelta, listener),
  onDone: (listener: (payload: TranslateDone) => void) => subscribe<TranslateDone>(IPC.translateDone, listener),
  onFailed: (listener: (payload: { requestId: string; failure: TranslationFailure }) => void) =>
    subscribe<{ requestId: string; failure: TranslationFailure }>(IPC.translateFailed, listener),

  expandPanel: () => ipcRenderer.invoke(IPC.windowExpand) as Promise<void>,
  collapsePanel: () => ipcRenderer.invoke(IPC.windowCollapse) as Promise<void>,
  togglePanel: () => ipcRenderer.invoke(IPC.windowToggle) as Promise<void>,
  hidePanel: () => ipcRenderer.invoke(IPC.windowHide) as Promise<void>,
  quitApp: () => ipcRenderer.invoke(IPC.windowQuit) as Promise<void>,
  getWindowMode: () => ipcRenderer.invoke(IPC.windowGetMode) as Promise<WindowModePayload>,
  onWindowMode: (listener: (payload: WindowModePayload) => void) =>
    subscribe<WindowModePayload>(IPC.windowMode, listener),
  onOpenSettings: (listener: () => void) => subscribe<unknown>(IPC.uiOpenSettings, () => listener()),

  startBallDrag: () => ipcRenderer.invoke(IPC.windowDragStart) as Promise<void>,
  endBallDrag: () => ipcRenderer.invoke(IPC.windowDragEnd) as Promise<void>,

  getShortcutStatus: () => ipcRenderer.invoke(IPC.shortcutGet) as Promise<ShortcutStatus>,
  setShortcut: (accelerator: string) =>
    ipcRenderer.invoke(IPC.shortcutSet, accelerator) as Promise<ShortcutStatus>,
  onShortcutStatus: (listener: (status: ShortcutStatus) => void) =>
    subscribe<ShortcutStatus>(IPC.shortcutStatus, listener),

  listSavedSentences: () => ipcRenderer.invoke(IPC.languageList) as Promise<SavedSentence[]>,
  saveSentence: (sentence: SavedSentenceDraft) =>
    ipcRenderer.invoke(IPC.languageSave, sentence) as Promise<SavedSentence[]>,
  removeSentence: (ref: SavedSentenceRef) =>
    ipcRenderer.invoke(IPC.languageRemove, ref) as Promise<SavedSentence[]>,
  clearSentences: () => ipcRenderer.invoke(IPC.languageClear) as Promise<SavedSentence[]>,

  listRecentTranslations: () =>
    ipcRenderer.invoke(IPC.recentList) as Promise<RecentTranslation[]>,
  clearRecentTranslations: () =>
    ipcRenderer.invoke(IPC.recentClear) as Promise<RecentTranslation[]>,

  getBridgeStatus: () => ipcRenderer.invoke(IPC.bridgeStatus) as Promise<BridgeStatus>,
  resetBridgeToken: () => ipcRenderer.invoke(IPC.bridgeResetToken) as Promise<BridgeStatus>,
  onBridgeStatus: (listener: (status: BridgeStatus) => void) =>
    subscribe<BridgeStatus>(IPC.bridgeStatusChanged, listener),
  onLearnSentence: (listener: (event: BridgeLearnEvent) => void) =>
    subscribe<BridgeLearnEvent>(IPC.uiLearnSentence, listener),
  openExtensionFolder: () =>
    ipcRenderer.invoke(IPC.extensionOpenFolder) as Promise<ExtensionFolderResult>,
  exportLearning: () => ipcRenderer.invoke(IPC.languageExport) as Promise<LearningExportResult>,
  openDataFolder: () => ipcRenderer.invoke(IPC.dataOpenFolder) as Promise<DataFolderResult>
}

contextBridge.exposeInMainWorld('api', api)
