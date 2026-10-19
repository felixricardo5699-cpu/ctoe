import { app, BrowserWindow, clipboard, safeStorage, shell } from 'electron'
import { DEFAULT_TASK, type ProviderSettings, type PublicSettings, type TranslationRequest } from '@shared/types'
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  languageName
} from '@shared/language/registry'
import { formatSentenceId } from '@shared/language/sentenceId'
import { IPC } from '@shared/types/ipc'
import { registerIpcHandlers, type IpcHandlers } from './ipc/handlers'
import { createProvider } from './services/ai/createProvider'
import { ProviderError } from './services/ai/errors'
import { BridgeService } from './services/bridge/bridgeService'
import { DOORBELL_SCHEME, doorbellRequested } from './services/bridge/doorbell'
import { ConfigStore } from './services/config/configStore'
import { createFilesController } from './services/export/filesController'
import { bundledExtensionFolder, isLoadableExtension } from './services/extension/extensionPackage'
import { LanguageStore } from './services/language/languageStore'
import { RecentStore } from './services/recent/recentStore'
import { GlobalShortcutService } from './services/shortcut/globalShortcutService'
import { applyLaunchAtLogin } from './services/startup/loginItem'
import { TrayService } from './services/tray/trayService'
import { attachEditContextMenu } from './services/window/editContextMenu'
import { FloatingWindowManager } from './services/window/windowManager'

/** Set CTOE_SMOKE=1 to boot headless, verify the ball and the panel render, then exit. */
const SMOKE_TEST = process.env.CTOE_SMOKE === '1'
/** Set CTOE_VERIFY_API=1 to run one real translation through the stored config, then exit. */
const VERIFY_API = process.env.CTOE_VERIFY_API === '1'
const SMOKE_TEST_TIMEOUT_MS = 30_000
/** Clipboard text the smoke test writes, then reads back through the input box button. */
const SMOKE_CLIPBOARD_TEXT = 'ctoe-smoke-clipboard'
/** Chinese the smoke test types into the panel; the smoke run forces the mock provider. */
const SMOKE_INPUT = '我觉得这个想法挺有意思，但是我不知道能不能成功。'
/** English the smoke test copies, as if it had been selected in another app. */
const SMOKE_READ_ENGLISH = 'I was going to join you, but something came up.'
/**
 * The sentence the smoke run pretends a browser pointed at. In French, because by the time the
 * bridge flow runs the profile has been switched to French; the mock answers any input, so what
 * the text actually says only matters for finding it again in the library afterwards.
 */
const SMOKE_BRIDGE_SENTENCE = 'Le musée ouvre ses portes à dix heures, mais il faut réserver sa place.'
/** Ceiling for one streamed mock answer (the whole run stays capped at 20s). */
const SMOKE_STEP_TIMEOUT_MS = 8_000
const DEFAULT_VERIFY_TEXT = '我觉得这个说法有点太绝对了。'
/**
 * The mode decides the direction; the text in the box never does. So the smoke run checks which
 * tab is pressed - Say it is native -> learning, Understand is the same pair walked back -
 * instead of trying to read a conclusion out of the box.
 */
const inMode = (label: string): string =>
  "(() => { const found = document.querySelector('.modebar__tab--active');" +
  ' return found !== null && found.textContent.trim() === ' + JSON.stringify(label) + ' })()'

// Optional portable mode: point all app data at a folder of your choice
// (default is the OS app-data directory, e.g. %APPDATA%/ctoe on Windows).
const dataDir = process.env.CTOE_DATA_DIR
if (dataDir !== undefined && dataDir.length > 0) app.setPath('userData', dataDir)

// The floating ball needs a transparent window, and Windows composites transparent
// windows on the GPU, so hardware acceleration stays on by default. CTOE_DISABLE_GPU=1
// is the escape hatch for machines with broken or missing drivers (VMs, RDP sessions).
if (process.env.CTOE_DISABLE_GPU === '1') app.disableHardwareAcceleration()

interface AppServices {
  config: ConfigStore
  windows: FloatingWindowManager
  shortcuts: GlobalShortcutService
  tray: TrayService
  bridge: BridgeService
  handlers: IpcHandlers
}

let services: AppServices | null = null

// A verification run only talks to the API, so it may start while the app is open.
if (!VERIFY_API && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  if (!VERIFY_API) registerAppHandlers()
  app
    .whenReady()
    .then(VERIFY_API ? verifyApi : start)
    .catch((error: unknown) => {
      console.error('[ctoe] failed to start:', error)
      app.exit(1)
    })
}

function registerAppHandlers(): void {
  // One window is the whole app; a second launch should open the panel instead. A `ctoe://` link
  // arrives as exactly that - a second launch - so the doorbell needs nothing extra here: the
  // window is already forward by the time the browser is able to retry.
  app.on('second-instance', () => services?.windows.expand())
  app.on('activate', () => services?.windows.showBall())

  app.on('before-quit', () => {
    services?.handlers.cancelAll()
    services?.windows.dispose()
  })

  app.on('will-quit', () => {
    services?.shortcuts.dispose()
    services?.tray.dispose()
    // Closing the port is part of quitting: a listener outliving the app would be a door left
    // open by something that is no longer there to answer.
    void services?.bridge.dispose()
  })
}

/**
 * Asks the OS to route `ctoe://` back to this app.
 *
 * The installer writes this entry, but a portable copy is never installed and a development run
 * writes nothing at all - so without this the doorbell would only ever ring for people who used
 * the installer. Registering here covers all three. The scheme is already declared in
 * electron-builder.yml; this only makes it true when nothing installed it.
 *
 * A failure is not worth stopping for: a locked-down machine can refuse the registry write, and
 * every other part of the browser bridge works without a doorbell.
 *
 * Skipped during the smoke run on purpose - that run is a development launch, so registering
 * would point the scheme at wherever this checkout happens to live, on a machine that may well
 * have the real app installed and already owning it.
 *
 * A portable copy is the one case the executable cannot answer for itself: it runs out of a
 * temporary folder the launcher deletes on exit, so naming process.execPath writes a scheme that
 * points at a file about to stop existing. The launcher hands the app the path of the executable
 * the user keeps, and that is what gets registered - it forwards the ctoe URL on to the app after
 * unpacking it.
 */
function registerDoorbellScheme(): void {
  if (SMOKE_TEST || VERIFY_API) return
  try {
    // A development run *is* the Electron binary, so the entry has to name the executable and the
    // script to load; a packaged build is its own executable and needs no argument.
    const script = process.argv[1]
    if (process.defaultApp === true && script !== undefined) {
      app.setAsDefaultProtocolClient(DOORBELL_SCHEME, process.execPath, [script])
      return
    }
    // Set by the portable launcher and nothing else, so its presence is what tells a run unpacked
    // into a temporary folder apart from one installed properly. That folder is deleted when the
    // app exits, so the file worth naming is the executable the user keeps.
    const portable = process.env.PORTABLE_EXECUTABLE_FILE
    if (portable !== undefined && portable !== '') {
      app.setAsDefaultProtocolClient(DOORBELL_SCHEME, portable, [])
      return
    }
    app.setAsDefaultProtocolClient(DOORBELL_SCHEME)
  } catch {
    // Deliberately silent: the doorbell is a convenience, and the bridge does not depend on it.
  }
}

function start(): void {
  if (process.platform === 'win32') app.setAppUserModelId('com.ctoe.assistant')
  registerDoorbellScheme()

  const config = ConfigStore.open()
  // My Learning lives next to the config, so CTOE_DATA_DIR isolates it too.
  const language = LanguageStore.open()
  // The recent list is the other local file, next to the config and the learning one.
  const recent = RecentStore.open()
  // The smoke test must always start from the same shape, whatever a previous run saved.
  if (SMOKE_TEST) {
    config.updateSettings({
      floatingBall: true,
      providerKind: 'mock',
      nativeLanguage: DEFAULT_NATIVE_LANGUAGE,
      learningLanguage: DEFAULT_LEARNING_LANGUAGE,
      // On for the run, so the smoke can prove a finished translation is remembered.
      recentPolicy: 'on'
    })
  }

  const windows = new FloatingWindowManager(config)
  const shortcuts = new GlobalShortcutService(config, {
    onTrigger: () => windows.toggle(),
    onStatus: (status) => windows.send(IPC.shortcutStatus, status)
  })

  const tray = new TrayService({
    openPanel: () => windows.expand(),
    openSettings: () => {
      windows.expand()
      windows.send(IPC.uiOpenSettings, null)
    },
    isBallVisible: () => windows.isBallVisible(),
    toggleBall: () => windows.toggleBallVisibility(),
    shortcutLabel: () => shortcuts.status().accelerator,
    quit: () => app.quit()
  })

  /**
   * The browser bridge: a second way into the same Learn pipeline the panel uses.
   *
   * It is told how to show itself and nothing else - bringing the panel forward when a sentence
   * arrives, and handing the filed sentence to the renderer. Everything about what a sentence
   * means to the user is decided inside the service and the stores behind it.
   */
  const bridge = BridgeService.open({
    config,
    stores: { config, language, recent },
    reveal: () => windows.expand(),
    onLearned: (event) => {
      // The window is brought forward first: the sentence is already saved, and showing it is
      // what makes the write visible rather than something that happened off screen.
      windows.expand()
      windows.send(IPC.uiLearnSentence, event)
    },
    version: app.getVersion()
  })

  // 随安装包一起分发的浏览器扩展。程序不会替用户安装它 —— Chrome 和 Edge 都不允许别的
  // 程序直接装扩展 —— 它能做的只是把那个文件夹打开，并告诉用户它在哪里。
  const extension = {
    folder: (): string | null => {
      const folder = bundledExtensionFolder({
        packaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath()
      })
      return isLoadableExtension(folder) ? folder : null
    },
    // shell.openPath 成功时 resolve 空串，失败时给出原因。
    reveal: (folder: string): Promise<string> => shell.openPath(folder)
  }

  const handlers = registerIpcHandlers({
    config,
    windows,
    shortcuts,
    language,
    recent,
    bridge,
    extension,
    // The OS-facing half of "export my learning": a folder picker, the file manager, and the path
    // the app keeps its own files in.
    files: createFilesController()
  })
  const window = windows.init()
  attachEditContextMenu(window)

  shortcuts.init()
  tray.init()
  applyLaunchAtLogin(config.readPublicSettings().launchAtLogin)

  services = { config, windows, shortcuts, tray, bridge, handlers }
  // A `ctoe://` link means a browser already tried the loopback bridge and found nothing
  // listening - that is the only reason it rings. This launch *is* the wake-up, so the panel opens
  // rather than the ball: whoever clicked should not have to go hunting for a floating dot.
  //
  // Nothing else about the link is read, and nothing about the bridge is changed. The doorbell
  // wakes; it does not decide - whether a sentence is learned is still the bridge's business, and
  // that is decided with a token. A second instance is handled by the `second-instance` listener,
  // which brings the same window forward whether or not a link caused it.
  if (doorbellRequested(process.argv)) windows.expand()
  // The stored policy is what decides whether a port is opened at all, so it takes effect on
  // launch as well as on the settings patch that changes it. A refusal here means the ports are
  // all taken - the settings page reads that as "not listening" the next time it asks, so there
  // is nothing to report to anyone and nothing worth taking the app down over.
  void bridge.applyPolicy().catch(() => undefined)
  if (SMOKE_TEST) wireSmokeTest(window, windows, language, recent, config, bridge)
}

/**
 * Boots headless, walks ball -> panel -> ball and exits non-zero if any step fails.
 * Cheap insurance that the real window, not just the unit tests, still works.
 */
function wireSmokeTest(
  window: BrowserWindow,
  windows: FloatingWindowManager,
  language: LanguageStore,
  recent: RecentStore,
  config: ConfigStore,
  bridge: BridgeService
): void {
  const timeout = setTimeout(() => fail('timeout waiting for the renderer'), SMOKE_TEST_TIMEOUT_MS)

  window.webContents.once('did-fail-load', (_event, code, description) => {
    fail(code + ' ' + description)
  })

  window.webContents.once('did-finish-load', () => {
    void (async (): Promise<void> => {
      try {
        // A `ctoe://` launch is the doorbell, and its whole job is to have the panel already open
        // instead of the ball. The run is started both ways, so this is the one place they differ.
        if (doorbellRequested(process.argv)) {
          if (!(await waitForSelector(window, '.assistant__title'))) {
            return fail('a doorbell launch did not open the panel')
          }
          console.log('SMOKE_INFO doorbell=opened-panel')
          windows.collapse()
        }
        if (!(await waitForSelector(window, '.floating-ball'))) return fail('the floating ball did not render')

        windows.expand()
        if (!(await waitForSelector(window, '.assistant__title'))) {
          return fail('the AI panel did not render after expanding')
        }
        // Read while the panel is still open: this is the auto-focus check.
        const focused = await readActiveElement(window)

        // The clipboard path goes renderer -> IPC -> main -> OS clipboard, so the real
        // button is pressed here instead of trusting the mocked unit tests.
        await clipboard.writeText(SMOKE_CLIPBOARD_TEXT)
        const imported = await pasteIntoInput(window)
        if (imported !== SMOKE_CLIPBOARD_TEXT) {
          return fail('the paste button did not import the clipboard (got ' + imported + ')')
        }

        // The paste button just filled the input box, so Generate runs on real content.
        const coach = await runCoachFlow(window, language, recent)
        if (coach.error !== null) return fail(coach.error)

        // Last, because it navigates to Settings and back: the picker writes the pair, the
        // panel relabels itself from the registry, and the file keeps the new value.
        const pair = await runLanguageFlow(window, config)
        if (pair.error !== null) return fail(pair.error)

        // After the switch on purpose: the row it learns from was written while the profile still
        // said English, so this is what proves a row is coached on its own terms.
        const recentLearn = await runRecentLearnFlow(window, language)
        if (recentLearn.error !== null) return fail(recentLearn.error)

        // The one step whose request comes from outside this process: a real HTTP call to the
        // loopback bridge, which is exactly what a browser extension will do.
        const bridged = await runBridgeFlow(window, bridge, config, language)
        if (bridged.error !== null) return fail(bridged.error)

        // Last, because it needs the panel in its busiest shape: the Learn note open.
        const learn = await verifyLearnPanel(window, windows)
        if (learn !== null) return fail(learn)

        windows.collapse()
        if (!(await waitForSelector(window, '.floating-ball'))) {
          return fail('the ball did not come back after collapsing')
        }

        clearTimeout(timeout)
        console.log('SMOKE_OK ball -> panel -> ball')
        console.log('SMOKE_INFO focused-element=' + focused)
        console.log('SMOKE_INFO mode-after-collapse=' + windows.windowMode().mode)
        console.log('SMOKE_INFO clipboard-import=' + imported)
        console.log('SMOKE_INFO coach-flow=ok')
        console.log('SMOKE_INFO learn-point=' + coach.learned)
        console.log('SMOKE_INFO learn-filed=' + String(coach.saved))
        console.log('SMOKE_INFO saved-sentence=' + coach.sentence)
        console.log('SMOKE_INFO learn-example-translation=' + coach.exampleTranslation)
        console.log('SMOKE_INFO learn-speakers=' + String(coach.speakers))
        console.log('SMOKE_INFO my-language=ok')
        console.log('SMOKE_INFO recent-remembered=' + String(coach.recent))
        console.log('SMOKE_INFO recent-learn=' + recentLearn.sentence)
        console.log('SMOKE_INFO recent-learn-pair=' + recentLearn.pair)
        console.log('SMOKE_INFO bridge-sentence=' + bridged.sentence)
        console.log('SMOKE_INFO bridge-pair=' + bridged.pair)
        console.log('SMOKE_INFO understand=' + coach.understood)
        console.log('SMOKE_INFO language-pair=' + pair.before + ' -> ' + pair.after)
        // Handy when a future agent debugs key storage on an unfamiliar machine.
        console.log('SMOKE_INFO encrypted-key-storage=' + String(safeStorage.isEncryptionAvailable()))
        app.exit(0)
      } catch (error) {
        fail(error instanceof Error ? error.message : 'unexpected smoke error')
      }
    })()
  })

  function fail(message: string): void {
    clearTimeout(timeout)
    console.error('SMOKE_FAIL ' + message)
    app.exit(1)
  }
}

/**
 * One real translation through whatever is configured in the settings file, so the API
 * key, the endpoint, the model and the streaming parser are validated together.
 * The key is never printed - only whether it is present and how long it is.
 */
async function verifyApi(): Promise<void> {
  const config = ConfigStore.open()
  const settings = config.readPublicSettings()

  console.log('VERIFY_INFO config=' + config.path)
  console.log(
    'VERIFY_INFO provider=' +
      settings.providerKind +
      ' model=' +
      settings.model +
      ' baseUrl=' +
      settings.baseUrl +
      ' languages=' +
      settings.nativeLanguage +
      '->' +
      settings.learningLanguage
  )

  const providerSettings = verifyProviderSettings(config, settings)
  if (providerSettings === null) {
    console.error('VERIFY_FAIL no API key stored; fill it in under Settings first.')
    app.exit(2)
    return
  }
  if (providerSettings.apiKey.trim().length === 0) {
    console.error(
      'VERIFY_FAIL the stored API key could not be decrypted in this session (OS crypto' +
        ' unavailable). Run the same command from your normal desktop session.'
    )
    app.exit(2)
    return
  }
  // The key itself is never printed, only how long it is.
  console.log('VERIFY_INFO apiKey=loaded(' + providerSettings.apiKey.length + ' chars)')

  const text = process.env.CTOE_VERIFY_TEXT ?? DEFAULT_VERIFY_TEXT
  // The languages come from the saved settings, so this exercises the pair the app will
  // really use - not a hardcoded zh -> en.
  const request: TranslationRequest = {
    task: DEFAULT_TASK,
    text,
    tone: 'natural',
    context: '',
    sourceLanguage: settings.nativeLanguage,
    targetLanguage: settings.learningLanguage
  }

  const startedAt = Date.now()
  let firstTokenAt = 0
  try {
    const provider = createProvider({ kind: settings.providerKind, settings: providerSettings })
    const result = await provider.translate(request, {
      onDelta: () => {
        if (firstTokenAt === 0) firstTokenAt = Date.now()
      }
    })
    console.log('VERIFY_INPUT ' + text)
    console.log('VERIFY_OUTPUT ' + result)
    console.log(
      'VERIFY_INFO ttft-ms=' +
        (firstTokenAt === 0 ? 'n/a' : String(firstTokenAt - startedAt)) +
        ' total-ms=' +
        String(Date.now() - startedAt)
    )
    console.log('VERIFY_OK')
    app.exit(0)
  } catch (error) {
    const message =
      error instanceof ProviderError ? error.code + ' (' + error.detail + ')' : String(error)
    console.error('VERIFY_FAIL ' + message)
    app.exit(1)
  }
}

/**
 * Normally the stored settings are used. The CTOE_VERIFY_* variables exist so a key can
 * be tried out (and this script can be exercised) without writing it to disk first.
 */
function verifyProviderSettings(config: ConfigStore, settings: PublicSettings): ProviderSettings | null {
  const apiKey = process.env.CTOE_VERIFY_API_KEY
  if (apiKey !== undefined && apiKey.length > 0) {
    return {
      baseUrl: process.env.CTOE_VERIFY_BASE_URL ?? settings.baseUrl,
      model: process.env.CTOE_VERIFY_MODEL ?? settings.model,
      apiKey
    }
  }
  return config.readProviderSettings()
}
async function waitForSelector(window: BrowserWindow, selector: string): Promise<boolean> {
  const script = "document.querySelector('" + selector + "') !== null"
  for (let attempt = 0; attempt < 60; attempt++) {
    const found = await window.webContents.executeJavaScript(script)
    if (found === true) return true
    await delay(100)
  }
  return false
}

/** Clicks the input box's paste button and returns what ended up in the textarea. */
async function pasteIntoInput(window: BrowserWindow): Promise<string> {
  try {
    return String(
      await window.webContents.executeJavaScript(
        "(async () => {" +
          " const button = document.querySelector('[aria-label=\"从剪贴板粘贴\"]');" +
          " if (button === null) return 'no-button';" +
          " button.click();" +
          " await new Promise((resolve) => setTimeout(resolve, 400));" +
          " const box = document.querySelector('.panel__text');" +
          " return box === null ? 'no-box' : box.value })()"
      )
    )
  } catch (error) {
    return 'error:' + (error instanceof Error ? error.message : String(error))
  }
}

/** Runs a renderer predicate until it is true, so the smoke test never guesses at timings. */
async function waitForRenderer(window: BrowserWindow, script: string): Promise<boolean> {
  const deadline = Date.now() + SMOKE_STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if ((await window.webContents.executeJavaScript(script)) === true) return true
    await delay(100)
  }
  return false
}

/**
 * Polls the main-process store until the predicate holds. Writes reach it asynchronously,
 * so waiting on the store is the only race-free way to check a save actually landed.
 */
async function waitForStore(predicate: () => boolean): Promise<boolean> {
  const deadline = Date.now() + SMOKE_STEP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(100)
  }
  return false
}

/** Clicks a button by its visible label; false when no such button exists. */
async function clickButton(window: BrowserWindow, label: string): Promise<boolean> {
  const script =
    "(() => { const found = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === " +
    JSON.stringify(label) +
    '); if (found === undefined) return false; found.click(); return true })()'
  return (await window.webContents.executeJavaScript(script)) === true
}

/**
 * Writes into the React-controlled input box the way a real keystroke would, so the
 * component state - not just the DOM - sees the text.
 */
async function typeIntoInput(window: BrowserWindow, text: string): Promise<string | null> {
  const script =
    "(() => { const box = document.querySelector('.panel__text');" +
    " if (box === null) return 'no input box';" +
    " const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;" +
    ' setter.call(box, ' + JSON.stringify(text) + ');' +
    " box.dispatchEvent(new Event('input', { bubbles: true }));" +
    " return '' })()"
  const error = String(await window.webContents.executeJavaScript(script))
  return error.length === 0 ? null : error
}

interface CoachFlowResult {
  /** Non-null when one of the steps did not happen. */
  error: string | null
  /** The first learn point the panel rendered, for the smoke log. */
  learned: string
  /** The example in the user's own language, which every point has to carry. */
  exampleTranslation: string
  /** How many read-aloud buttons the note drew in the real renderer. */
  speakers: number
  /** True once the sentence Learn analysed reached the local learning file. */
  saved: boolean
  /** The id and the point count the learned sentence came back with, for the smoke log. */
  sentence: string
  /** The Chinese meaning the Understand run put on screen. */
  understood: string
  /** How many rows the recent list holds after the run, which is what proves it was written. */
  recent: number
}

/**
 * Walks both directions of the product through the real renderer: type the Chinese, click
 * Generate, wait for the streamed English, ask for the Learn analysis - which is what files the
 * sentence - then bring copied English in through the clipboard and explain it. The smoke run
 * forces the mock provider, so this also proves the structured answers are parsed into the
 * panel - not just fetched.
 */
async function runCoachFlow(
  window: BrowserWindow,
  language: LanguageStore,
  recent: RecentStore
): Promise<CoachFlowResult> {
  const stop = (error: string): CoachFlowResult => ({
    error,
    learned: '',
    exampleTranslation: '',
    speakers: 0,
    saved: false,
    sentence: '',
    understood: '',
    recent: 0
  })

  const typed = await typeIntoInput(window, SMOKE_INPUT)
  if (typed !== null) return stop(typed)

  // What the recent list held before this run: the run's own setting turns recording on, so the
  // finished translation has to end up in it.
  const beforeRecent = recent.list().length
  if (!(await clickButton(window, 'Generate'))) return stop('the Generate button is missing')
  const hasOutput = "document.querySelectorAll('.panel__text')[1].value.trim().length > 0"
  if (!(await waitForRenderer(window, hasOutput))) return stop('Generate produced no English')
  // The row is written by the main process as the answer lands, not by the panel, so this is
  // checked against the store itself rather than against anything the UI drew.
  if (!(await waitForStore(() => recent.list().length > beforeRecent))) {
    return stop('the finished translation was not remembered in the recent list')
  }

  // What the library held before this run: a smoke run may start from an existing file - a
  // migrated one, say - so what Learn has to do is add one sentence, not be the only one there.
  const beforeLearn = language.list().length

  // Learn unlocks only once the stream finished, so wait for that state instead of a timer.
  const learnReady =
    "(() => { const found = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Learn');" +
    ' return found !== undefined && !found.disabled })()'
  if (!(await waitForRenderer(window, learnReady))) return stop('Learn never became available')
  if (!(await clickButton(window, 'Learn'))) return stop('the Learn button is missing')

  const titled =
    "(() => { const found = document.querySelector('.analysis__title');" +
    " return found !== null && found.textContent === 'Learn this' })()"
  if (!(await waitForRenderer(window, titled))) return stop('Learn produced no analysis')
  // The note streams in point by point, so everything below reads the finished answer rather
  // than whatever had arrived first: the Learn button is disabled for exactly as long as the
  // answer is still on its way, which is the same settle signal the layout check waits on.
  if (!(await waitForRenderer(window, learnReady))) return stop('the Learn answer never settled')

  const learned = String(
    await window.webContents.executeJavaScript(
      "(() => { const found = document.querySelector('.analysis__expression');" +
      " return found === null ? '' : found.textContent })()"
    )
  )
  if (learned.length === 0) return stop('the learn panel rendered no point')

  // "How is it used" and "how does it sound" are answered by the note itself now: every point
  // shows its example in both languages and offers to read the learning one out loud. Whether
  // this machine has a voice is not the smoke's business - that the lines are drawn is.
  const translatedExample =
    "(() => { const found = document.querySelector('.analysis__example-translation');" +
    " return found !== null && found.textContent.trim().length > 0 })()"
  if (!(await waitForRenderer(window, translatedExample))) {
    return stop('the learn point did not translate its example')
  }
  const noteParts = JSON.parse(
    String(
      await window.webContents.executeJavaScript(
        "(() => { const translation = document.querySelector('.analysis__example-translation');" +
          " const speakers = document.querySelectorAll('.analysis .speak').length;" +
          " return JSON.stringify({ translation: translation === null ? '' : translation.textContent, speakers: speakers }) })()"
      )
    )
  ) as { translation: string; speakers: number }
  if (noteParts.speakers === 0) return stop('the learn note has no read-aloud button')

  // Asking for the note is the study act: the main process files the sentence in the same round
  // trip that produced the note, so what the panel shows is a receipt rather than a button.
  // Nothing is pressed here, because asking for the note was the whole of it.
  const receiptShown =
    "(() => { const note = document.querySelector('.analysis__saved');" +
    " return note !== null && note.textContent.indexOf('Added to My Learning') === 0 })()"
  if (!(await waitForRenderer(window, receiptShown))) return stop('the Learn note gave no receipt')
  const receipt = String(
    await window.webContents.executeJavaScript(
      "(() => { const note = document.querySelector('.analysis__saved');" +
      " return note === null ? '' : note.textContent })()"
    )
  )

  // The sentence reaches the disk over IPC, so wait for the store itself. Reading My Learning on
  // a timer would race the write and report a learned sentence as missing.
  if (!(await waitForStore(() => language.list().length > beforeLearn))) {
    return stop('learning the sentence did not stick')
  }
  // One Learn is one moment, and the points travel inside it rather than beside it: a store that
  // had grown by one row per point would mean the old per-point model had come back.
  const storedRows = language.list()
  if (storedRows.length !== beforeLearn + 1) {
    return stop('one Learn wrote ' + String(storedRows.length - beforeLearn) + ' sentences instead of one')
  }
  const stored = storedRows[0]
  if (stored === undefined || stored.knowledgePoints.length === 0) {
    return stop('the saved sentence kept none of the points learned from it')
  }
  // The receipt names the same number the file has, so the panel and the disk agree about which
  // sentence this was - the check the mocked unit tests cannot make.
  if (!receipt.includes(formatSentenceId(stored.id))) {
    return stop('the receipt did not name the sentence that was filed')
  }
  const savedSentence = formatSentenceId(stored.id) + ' (' + String(stored.knowledgePoints.length) + ' points)'
  // The shelf the moment was filed under, named the way My Learning names it: the learning relation
  // (what the user speaks, and what they are learning), not the direction this one sentence went.
  const pairLabel = languageName(stored.nativeLanguage) + ' → ' + languageName(stored.learningLanguage)
  const openPair =
    "(() => { const pair = [...document.querySelectorAll('.language__pair-button')].find((item) => item.textContent.indexOf(" +
    JSON.stringify(pairLabel) +
    ") !== -1); if (pair === undefined) return 'missing'; pair.click(); return pair.textContent })()"

  // Then read it back out of My Learning, which goes through the store and not just state. It
  // opens on the language pairs, because a saved moment belongs to exactly one pair, so the pair
  // is opened first and the sentence inside it is what gets checked.
  if (!(await clickButton(window, 'My Learning'))) return stop('the My Learning button is missing')
  const landed =
    "(() => { return [...document.querySelectorAll('.language__pair-button')].some((item) => item.textContent.indexOf(" +
    JSON.stringify(pairLabel) +
    ') !== -1) })()'
  if (!(await waitForRenderer(window, landed))) return stop('My Learning does not list ' + pairLabel)
  if ((await window.webContents.executeJavaScript(openPair)) === 'missing') {
    return stop('the ' + pairLabel + ' pair button is missing')
  }
  // The card is the sentence, and the knowledge inside it starts folded away - so the count is
  // what the list has to show, and the point text is what it must not show until it is opened.
  const knowledgeLine =
    'KNOWLEDGE · ' +
    String(stored.knowledgePoints.length) +
    (stored.knowledgePoints.length === 1 ? ' point' : ' points')
  const listed =
    "(() => { const record = document.querySelector('.language__record');" +
    " if (record === null) return false;" +
    " return record.textContent.includes(" + JSON.stringify(stored.translatedText) + ")" +
    " && record.textContent.includes(" + JSON.stringify(knowledgeLine) + ")" +
    " && record.textContent.indexOf(" + JSON.stringify(learned) + ") === -1" +
    " && record.querySelectorAll('.analysis__item').length === 0 })()"
  if (!(await waitForRenderer(window, listed))) return stop('the saved sentence is not in My Learning')
  // One press on the card, and everything inside it is on the page: the fold is a fold, not a cap.
  const openKnowledge =
    "(() => { const button = document.querySelector('.language__record .language__knowledge-toggle');" +
    " if (button === null) return 'missing'; button.click(); return button.textContent })()"
  if ((await window.webContents.executeJavaScript(openKnowledge)) === 'missing') {
    return stop('the saved sentence offers no way to open its points')
  }
  const opened =
    "(() => { const record = document.querySelector('.language__record');" +
    " if (record === null) return false;" +
    " return record.querySelectorAll('.analysis__item').length === " +
    String(stored.knowledgePoints.length) +
    " && record.textContent.includes(" + JSON.stringify(learned) + ") })()"
  if (!(await waitForRenderer(window, opened))) {
    return stop('opening the saved sentence showed none of its points')
  }
  // The card has to carry the pair-local id the store allocated, drawn as six hex digits.
  const idShown =
    "(() => { const id = document.querySelector('.language__id');" +
    ' return id !== null && id.textContent.trim() === ' + JSON.stringify(formatSentenceId(stored.id)) + ' })()'
  if (!(await waitForRenderer(window, idShown))) {
    return stop('the saved sentence did not come back labelled ' + formatSentenceId(stored.id))
  }
  if (!(await clickButton(window, '返回'))) return stop('the back button is missing')
  if (!(await waitForSelector(window, '.assistant__title'))) return stop('could not get back to the panel')

  // The other direction is the other mode. The box the Chinese was typed into is left alone:
  // Understand keeps its own, empty draft, and the clipboard is still the only way text gets in
  // because this app deliberately never reads other windows.
  if (!(await clickButton(window, 'Understand'))) return stop('the Understand tab is missing')
  if (!(await waitForRenderer(window, inMode('Understand')))) {
    return stop('the panel did not switch to Understand')
  }
  await clipboard.writeText(SMOKE_READ_ENGLISH)
  const importedEnglish = await pasteIntoInput(window)
  if (importedEnglish !== SMOKE_READ_ENGLISH) {
    return stop('paste selected text did not import the English (got ' + importedEnglish + ')')
  }
  if (!(await clickButton(window, 'Explain'))) return stop('the Explain button is missing')
  const meaningShown =
    "(() => { const found = document.querySelectorAll('.panel__text')[1];" +
    " return found !== undefined && found.value.indexOf('我本来打算') === 0 })()"
  if (!(await waitForRenderer(window, meaningShown))) return stop('Understand produced no meaning')
  const understood = String(
    await window.webContents.executeJavaScript(
      "(() => { const found = document.querySelectorAll('.panel__text')[1];" +
      " return found === undefined ? '' : found.value })()"
    )
  )
  // The check above only waits for the first characters of the meaning, so let the run settle
  // before judging what the box says next.
  const understandSettled =
    "(() => { const found = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Explain');" +
    ' return found !== undefined && !found.disabled })()'
  if (!(await waitForRenderer(window, understandSettled))) return stop('Explain never finished streaming')
  // Round trip through the tabs: the English that was about to be explained has to survive it,
  // because each mode keeping its own draft is the whole point of not sharing one box.
  if (!(await clickButton(window, 'Say it'))) return stop('the Say it tab is missing')
  if (!(await waitForRenderer(window, inMode('Say it')))) return stop('the panel did not go back to Say it')
  if (!(await clickButton(window, 'Understand'))) return stop('the Understand tab is missing again')
  if (!(await waitForRenderer(window, inMode('Understand')))) {
    return stop('the panel did not go back to Understand')
  }
  const keptDraft =
    "(() => { const box = document.querySelector('.panel__text');" +
    ' return box !== null && box.value === ' + JSON.stringify(SMOKE_READ_ENGLISH) + ' })()'
  if (!(await waitForRenderer(window, keptDraft))) return stop('switching modes dropped the pasted draft')
  // Back to Say it, where the next step expects the writing button and the Chinese box.
  if (!(await clickButton(window, 'Say it'))) return stop('the Say it tab is missing again')
  if (!(await waitForRenderer(window, inMode('Say it')))) return stop('the panel did not return to Say it')
  if (!(await waitForSelector(window, '.assistant__title'))) return stop('the panel left the coach screen')

  return {
    error: null,
    learned,
    exampleTranslation: noteParts.translation,
    speakers: noteParts.speakers,
    saved: true,
    sentence: savedSentence,
    understood,
    recent: recent.list().length
  }
}

/** What learning from the recent list proved, for the smoke log. */
interface RecentLearnResult {
  error: string | null
  /** The receipt the row came back with: the number, and how many points it kept. */
  sentence: string
  /** The relation the sentence was filed under, named the way My Learning names it. */
  pair: string
}

/**
 * Learn, asked of a sentence the user translated earlier and has since moved on from.
 *
 * The row this presses is the English that was read during the coach flow, written while the
 * profile still said English - and by the time it is pressed the profile says French. So the
 * sentence has to be filed under the row's own relation (Chinese native, English learned), which
 * is the one check that tells 'the row says what it teaches' apart from 'the settings say what to
 * learn': a page that coached the current profile instead would file this under French.
 */
async function runRecentLearnFlow(
  window: BrowserWindow,
  language: LanguageStore
): Promise<RecentLearnResult> {
  const stop = (error: string): RecentLearnResult => ({ error, sentence: '', pair: '' })
  const before = language.list().length

  if (!(await clickButton(window, '最近翻译'))) return stop('the recent button is missing')
  if (!(await waitForRenderer(window, "document.querySelectorAll('.recent__head').length > 0"))) {
    return stop('the recent list did not open')
  }

  // The row that was read during the coach flow, found by the pair it went in - the direction of
  // one moment, not the relation it belongs to.
  const rowScript =
    "(() => { const rows = [...document.querySelectorAll('.language__record')];" +
    " return rows.find((item) => { const pair = item.querySelector('.recent__pair');" +
    " return pair !== null && pair.textContent.indexOf('English → Chinese') !== -1 }) ?? null })()"
  const press =
    '(() => { const row = ' +
    rowScript +
    "; if (row === null) return 'missing';" +
    " const button = [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Learn');" +
    " if (button === undefined) return 'learned'; button.click(); return 'pressed' })()"
  const pressed = String(await window.webContents.executeJavaScript(press))
  if (pressed === 'missing') return stop('the recent list does not hold the sentence that was read')
  if (pressed === 'learned') return stop('a recent row was already learned before it was asked about')

  const noted =
    "(() => { const note = document.querySelector('.language__record .analysis__title');" +
    " return note !== null && note.textContent === 'Learn this' })()"
  if (!(await waitForRenderer(window, noted))) {
    return stop('Learn from the recent list produced no note')
  }
  if (!(await waitForStore(() => language.list().length > before))) {
    return stop('learning from the recent list did not stick')
  }

  const filed = language.list().find((item) => item.originalText === SMOKE_READ_ENGLISH)
  if (filed === undefined) return stop('the sentence that was read is not in the library')
  // Filed under the row's own relation, not the one the settings name now.
  if (filed.nativeLanguage !== 'zh' || filed.learningLanguage !== 'en') {
    return stop(
      'the recent row was filed as ' +
        filed.nativeLanguage +
        ' learning ' +
        filed.learningLanguage +
        ' instead of Chinese learning English'
    )
  }
  // And as the moment went rather than as the ask went: this one was read, so English came in.
  if (filed.sourceLanguage !== 'en' || filed.targetLanguage !== 'zh') {
    return stop('the recent row was filed the wrong way round')
  }
  if (filed.knowledgePoints.length === 0) {
    return stop('the sentence learned from the recent list kept none of its points')
  }

  // The row now reads as learned, with the same number the file has, and its Learn is gone.
  const receipt = formatSentenceId(filed.id)
  const settled =
    '(() => { const row = ' +
    rowScript +
    "; if (row === null) return false;" +
    " const learn = [...row.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Learn');" +
    " return row.textContent.includes('已学习 · ' + " +
    JSON.stringify(receipt) +
    ') && learn === undefined })()'
  if (!(await waitForRenderer(window, settled))) {
    return stop('the recent row did not come back labelled ' + receipt)
  }

  if (!(await clickButton(window, '返回'))) return stop('the back button is missing')
  if (!(await waitForSelector(window, '.assistant__title'))) return stop('could not get back to the panel')
  return {
    error: null,
    sentence: receipt + ' (' + String(filed.knowledgePoints.length) + ' points)',
    pair: languageName(filed.nativeLanguage) + ' → ' + languageName(filed.learningLanguage)
  }
}

/** What a sentence sent from outside the app proved, for the smoke log. */
interface BridgeFlowResult {
  error: string | null
  /** The number it came back with, and how many points it kept. */
  sentence: string
  /** The relation it landed in, named the way My Learning names it. */
  pair: string
}

/** What one POST /v1/learn came back with, or why it did not. */
interface BridgeCall {
  error: string | null
  /** The task the extension would poll, which is what this run polls next. */
  taskId: string
}

/** What one GET /v1/task/:id said about a sentence, or why it could not be read. */
interface BridgeTaskRead {
  error: string | null
  state: string
  sentenceId: number | null
}

/**
 * A sentence arriving from outside this process, over a real socket.
 *
 * Every other step of this run drives the app through its own UI. This one is the whole point of
 * the bridge: something that is not the panel speaks HTTP to a loopback port, and the sentence has
 * to end up in My Learning exactly as if the user had pressed Learn - and the window has to show
 * it. So the run opens the port the way the settings switch does, posts one sentence to it, and
 * then checks both ends: the file grew by one, the task came back learned with the number the file
 * holds, and the panel switched to the receipt page before it was sent back.
 */
async function runBridgeFlow(
  window: BrowserWindow,
  bridge: BridgeService,
  config: ConfigStore,
  language: LanguageStore
): Promise<BridgeFlowResult> {
  const stop = (error: string): BridgeFlowResult => ({ error, sentence: '', pair: '' })
  const before = language.list().length

  // Switching the bridge on is a settings patch and the service only catches up with it, so both
  // halves are done here - the settings-page path is already covered by the language flow.
  config.updateSettings({ browserBridgePolicy: 'on' })
  await bridge.applyPolicy()
  const status = bridge.status()
  if (status.port === null) return stop('the bridge did not open a port when it was switched on')
  if (status.token.length === 0) return stop('the bridge had no token to pair with')

  const accepted = await postBridgeLearn(status.port, status.token, SMOKE_BRIDGE_SENTENCE)
  if (accepted.error !== null) return stop(accepted.error)

  if (!(await waitForStore(() => language.list().length > before))) {
    return stop('the sentence sent to the bridge was not filed')
  }
  const filed = language.list().find((item) => item.originalText === SMOKE_BRIDGE_SENTENCE)
  if (filed === undefined) return stop('the sentence sent to the bridge is not in the library')

  const task = await readSettledTask(status.port, status.token, accepted.taskId)
  if (task.error !== null) return stop(task.error)
  if (task.state !== 'learned') {
    return stop('the bridge reported the sentence as ' + (task.state === '' ? 'unknown' : task.state))
  }
  // The number the protocol hands back is the one on disk, or the extension would label the
  // sentence differently from My Learning.
  if (task.sentenceId !== filed.id) {
    return stop(
      'the bridge reported id ' +
        String(task.sentenceId) +
        ' for a sentence filed as ' +
        formatSentenceId(filed.id)
    )
  }

  // The receipt page: a write the user did not ask for from here is worth showing rather than
  // letting it pass as something that happened off screen.
  const showing =
    "(() => { const title = document.querySelector('.settings__title');" +
    " return title !== null && title.textContent === '来自浏览器' })()"
  if (!(await waitForRenderer(window, showing))) {
    return stop('the window did not show what the browser sent')
  }

  // Back to the panel, so the steps after this one start from the shape they expect.
  if (!(await clickButton(window, '返回'))) return stop('the back button is missing')
  if (!(await waitForSelector(window, '.assistant__title'))) {
    return stop('could not get back to the panel from the browser receipt')
  }

  return {
    error: null,
    sentence:
      formatSentenceId(filed.id) + ' (' + String(filed.knowledgePoints.length) + ' points)',
    pair: languageName(filed.nativeLanguage) + ' → ' + languageName(filed.learningLanguage)
  }
}

/** One POST /v1/learn, sent the way an extension would send it. */
async function postBridgeLearn(port: number, token: string, text: string): Promise<BridgeCall> {
  const stop = (error: string): BridgeCall => ({ error, taskId: '' })
  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(bridgeUrl(port, '/v1/learn'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ requestId: 'smoke-bridge-1', text })
    })
  } catch (error) {
    return stop('the bridge could not be reached: ' + String(error))
  }
  // Accepted, not finished: the work is queued and the task id is what the answer is polled by.
  if (response.status !== 202) return stop('the bridge answered ' + String(response.status))
  const body = (await response.json()) as { ok?: unknown; taskId?: unknown }
  if (body.ok !== true || typeof body.taskId !== 'string') return stop('the bridge sent no task id')
  return { error: null, taskId: body.taskId }
}

/** Polls GET /v1/task/:id until the run has settled, which is how an extension reads an answer. */
async function readSettledTask(
  port: number,
  token: string,
  taskId: string
): Promise<BridgeTaskRead> {
  const deadline = Date.now() + SMOKE_STEP_TIMEOUT_MS
  let read = await readBridgeTask(port, token, taskId)
  while (read.error === null && read.state === 'pending' && Date.now() < deadline) {
    await delay(100)
    read = await readBridgeTask(port, token, taskId)
  }
  return read
}

async function readBridgeTask(
  port: number,
  token: string,
  taskId: string
): Promise<BridgeTaskRead> {
  const stop = (error: string): BridgeTaskRead => ({ error, state: '', sentenceId: null })
  let response: Awaited<ReturnType<typeof fetch>>
  try {
    response = await fetch(bridgeUrl(port, '/v1/task/' + taskId), {
      headers: { authorization: 'Bearer ' + token }
    })
  } catch (error) {
    return stop('the task could not be read: ' + String(error))
  }
  if (response.status !== 200) return stop('the task answered ' + String(response.status))
  const body = (await response.json()) as { state?: unknown; sentenceId?: unknown }
  return {
    error: null,
    state: typeof body.state === 'string' ? body.state : '',
    sentenceId: typeof body.sentenceId === 'number' ? body.sentenceId : null
  }
}

/** The loopback address the bridge listens on, which is the only host it ever binds. */
function bridgeUrl(port: number, path: string): string {
  return 'http://127.0.0.1:' + String(port) + path
}

interface PanelLayout {
  /** The panel's inner width, which is what a header button must stay inside. */
  viewport: number
  header: Array<{ label: string; hit: string; box: number[] | null }>
  chrome: Array<{ label: string | null; hit: string }>
  footerHit: string | null
  panels: Array<number[] | null>
  analysis: number[] | null
}

/**
 * The Learn note is the only block the user opens on purpose, so it is also the only one that
 * can trap them: a note that squashed the two text boxes or covered the window buttons would
 * leave the compact panel with no visible way back. jsdom has no layout, so the real renderer
 * is the only place this regression can be caught.
 */
async function verifyLearnPanel(window: BrowserWindow, windows: FloatingWindowManager): Promise<string | null> {
  const layoutScript = [
    "(() => { ",
    " const vw = document.documentElement.clientWidth, vh = document.documentElement.clientHeight",
    " const rect = (el) => { if (el === null) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }",
    " const hit = (el) => { if (el === null) return 'missing'; const r = el.getBoundingClientRect();" +
      " const x = r.left + r.width / 2, y = r.top + r.height / 2;" +
      " if (x < 0 || y < 0 || x > vw || y > vh) return 'off-window';" +
      " const top = document.elementFromPoint(x, y);" +
      " return top === el ? 'clickable' : 'covered-by:' + (top ? (top.className || top.tagName) : 'null') }",
    " const footer = document.querySelector('.assistant__footer')",
    // The page links share the top row with the window buttons, and a header that pushed one of
    // them off the panel would leave the user with no way into My Learning or the recent list.
    " const header = Array.from(document.querySelectorAll('.assistant__header-actions button')).map((el) => ({",
    "  label: (el.getAttribute('aria-label') || el.textContent || '').trim(), hit: hit(el), box: rect(el) }))",
    " return JSON.stringify({",
    "  viewport: vw,",
    "  header,",
    "  chrome: Array.from(document.querySelectorAll('.chrome')).map((el) => ({ label: el.getAttribute('aria-label'), hit: hit(el) })),",
    "  footerHit: footer === null ? 'missing' : hit(footer.querySelector('button')),",
    "  panels: Array.from(document.querySelectorAll('.panel__text')).map(rect),",
    "  analysis: rect(document.querySelector('.analysis'))",
    " })",
    "})()"
  ].join('\n')
  const clampNote = "(() => { const note = document.querySelector('.analysis'); if (note !== null) note.style.height = '200px'; return true })()"
  const releaseNote = "(() => { const note = document.querySelector('.analysis'); if (note !== null) note.style.height = ''; return true })()"
  const learnReady =
    "(() => { const found = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Learn');" +
    ' return found !== undefined && !found.disabled })()'

  const measure = async (): Promise<PanelLayout> =>
    JSON.parse(String(await window.webContents.executeJavaScript(layoutScript))) as PanelLayout

  /** Nothing the user needs may be off-window, covered, or squashed into a sliver. */
  const check = (layout: PanelLayout, stage: string): string | null => {
    if (layout.header.length === 0) return 'the panel lost its header buttons ' + stage
    const unreachable = layout.header.find((entry) => entry.hit !== 'clickable')
    if (unreachable !== undefined) {
      return 'the ' + unreachable.label + ' header button is ' + unreachable.hit + ' ' + stage
    }
    // Wrapping is the fallback, being pushed off the panel is not: a label the panel cannot show
    // is the same as a page the user cannot reach.
    const spilled = layout.header.find(
      (entry) => entry.box === null || entry.box[0] < 0 || entry.box[0] + entry.box[2] > layout.viewport
    )
    if (spilled !== undefined) return 'the ' + spilled.label + ' header button is off the panel ' + stage
    if (layout.chrome.length === 0) return 'the panel lost its window buttons ' + stage
    const blocked = layout.chrome.find((entry) => entry.hit !== 'clickable')
    if (blocked !== undefined) return 'the ' + String(blocked.label) + ' button is ' + blocked.hit + ' ' + stage
    if (layout.footerHit !== 'clickable') return 'the toolbar buttons are ' + String(layout.footerHit) + ' ' + stage
    const squashed = layout.panels.find((panel) => panel === null || panel[3] < 40)
    if (squashed !== undefined) {
      return 'a text box was squashed to ' + String(squashed === null ? 'nothing' : squashed[3]) + 'px ' + stage
    }
    return null
  }

  await typeIntoInput(window, SMOKE_INPUT)
  if (!(await clickButton(window, 'Generate'))) return 'the Generate button is missing again'
  const hasOutput = "document.querySelectorAll('.panel__text')[1].value.trim().length > 0"
  if (!(await waitForRenderer(window, hasOutput))) return 'the second Generate produced nothing'
  if (!(await waitForRenderer(window, learnReady))) return 'Learn never became available again'
  if (!(await clickButton(window, 'Learn'))) return 'the Learn button is missing again'
  if (!(await waitForRenderer(window, "document.querySelector('.analysis') !== null"))) {
    return 'the second Learn produced no note'
  }
  await delay(150)

  const open = check(await measure(), 'with the learn note open')
  if (open !== null) return open

  // Worst case on purpose: a real note can sit at its clamp, and the boxes must survive that.
  await window.webContents.executeJavaScript(clampNote)
  await delay(150)
  const tallLayout = await measure()
  const tall = check(tallLayout, 'with a full-height learn note')
  console.log(
    'SMOKE_INFO learn-note-box-heights=' +
      JSON.stringify(tallLayout.panels.map((panel) => (panel === null ? null : panel[3])))
  )
  if (tall !== null) return tall
  await window.webContents.executeJavaScript(releaseNote)
  await delay(150)

  // Closing the note has to hand the leaner panel back without throwing the answer away.
  const dismissed = String(
    await window.webContents.executeJavaScript(
      "(() => { const close = document.querySelector('.analysis__close'); if (close === null) return 'missing'; close.click(); return 'clicked' })()"
    )
  )
  if (dismissed !== 'clicked') return 'the learn note has no way to close it (' + dismissed + ')'
  await delay(150)
  const closed = String(
    await window.webContents.executeJavaScript(
      "(() => { if (document.querySelector('.analysis') !== null) return 'still-open';" +
        " return document.querySelectorAll('.panel__text')[1].value.trim().length > 0 ? 'closed' : 'answer-lost' })()"
    )
  )
  if (closed !== 'closed') return 'closing the learn note left the panel as ' + closed

  // And it has to be possible to ask for it again.
  if (!(await waitForRenderer(window, learnReady))) return 'Learn did not come back after closing the note'
  if (!(await clickButton(window, 'Learn'))) return 'Learn could not be asked for twice'

  // The direction switch is disabled while a request runs, so let the reopened note settle first.
  if (!(await waitForRenderer(window, learnReady))) return 'the reopened Learn note never settled'

  // Explaining stacks the same note under an extra paragraph, so check that mode too. The tab
  // is what flips the direction, so this also asserts the switch really does change it.
  if (!(await clickButton(window, 'Understand'))) return 'the Understand tab is missing again'
  if (!(await waitForRenderer(window, inMode('Understand')))) {
    return 'the panel did not switch to Understand'
  }
  // Typed rather than pasted: the clipboard path already ran earlier.
  await typeIntoInput(window, SMOKE_READ_ENGLISH)
  if (!(await clickButton(window, 'Explain'))) return 'the Explain button is missing again'
  const meaningShown =
    "(() => { const found = document.querySelectorAll('.panel__text')[1];" +
    " return found !== undefined && found.value.indexOf('我本来打算') === 0 })()"
  if (!(await waitForRenderer(window, meaningShown))) {
    return 'the second Understand produced no meaning'
  }
  if (!(await waitForRenderer(window, "document.querySelector('.analysis') !== null"))) {
    return 'the second Understand produced no note'
  }
  await delay(150)
  const understand = check(await measure(), 'with the meaning and the note on screen')
  if (understand !== null) return understand
  await window.webContents.executeJavaScript(clampNote)
  await delay(150)
  const understandLayout = await measure()
  const understandTall = check(understandLayout, 'with a full-height note in Understand mode')
  console.log(
    'SMOKE_INFO understand-note-box-heights=' +
      JSON.stringify(understandLayout.panels.map((panel) => (panel === null ? null : panel[3])))
  )
  if (understandTall !== null) return understandTall
  await window.webContents.executeJavaScript(releaseNote)
  await delay(200)

  // Learn from the reading side too: the sentence worth studying is still the learning-language
  // one, which here is the English that was read and not the Chinese meaning beside it. The note
  // is closed first so the check cannot pass on the one Explain already produced.
  const closedAgain = String(
    await window.webContents.executeJavaScript(
      "(() => { const close = document.querySelector('.analysis__close'); if (close === null) return 'missing'; close.click(); return 'clicked' })()"
    )
  )
  if (closedAgain !== 'clicked') return 'the Understand note has no way to close it (' + closedAgain + ')'
  await delay(150)
  if (!(await waitForRenderer(window, learnReady))) return 'Learn never became available in Understand'
  if (!(await clickButton(window, 'Learn'))) return 'the Learn button is missing in Understand'
  if (!(await waitForRenderer(window, "document.querySelector('.analysis') !== null"))) {
    return 'Learn produced no note in Understand mode'
  }
  await delay(150)

  // Collapsing is the other way out, and it has to work with the note on screen.
  const collapsed = String(
    await window.webContents.executeJavaScript(
      "(() => { const button = document.querySelector('.chrome'); if (button === null) return 'missing';" +
        ' const label = button.getAttribute("aria-label"); button.click(); return label })()'
    )
  )
  await delay(500)
  if (windows.windowMode().mode !== 'ball') {
    return 'the collapse button (' + collapsed + ') did not bring the ball back'
  }
  windows.expand()
  await delay(500)
  return null
}

interface LanguageFlowResult {
  /** Non-null when one of the steps did not happen. */
  error: string | null
  /** The placeholder the answer box showed before the switch, then after it. */
  before: string
  after: string
}

/** Where the settings header sits, and whether its buttons can still be pressed. */
interface HeaderLayout {
  error?: string
  headerTop: number
  headerBottom: number
  back: string
  chrome: string
  bodyTop: number
  scrollTop: number
  clientHeight: number
  scrollHeight: number
}

/**
 * The settings page is the long one, and its header carries the way back plus the two window
 * buttons - so scrolling the page must not take them off the screen, and the content must not
 * slide underneath them. jsdom has no layout at all, so this is measured on the real renderer,
 * the same way the Learn note's geometry is.
 */
async function verifyFixedHeader(window: BrowserWindow): Promise<string | null> {
  const probe = [
    '(() => {',
    " const header = document.querySelector('.settings__header')",
    " const body = document.querySelector('.settings__body')",
    " if (header === null || body === null) return JSON.stringify({ error: 'no-header' })",
    ' const h = header.getBoundingClientRect()',
    " const hit = (el) => { if (el === null) return 'missing'; const r = el.getBoundingClientRect();" +
      " const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);" +
      " return top === el ? 'clickable' : 'covered-by:' + (top ? (top.className || top.tagName) : 'null') }",
    " // The scroller's own top edge is what has to sit below the header: content above the" +
      ' // scroll position is meant to be off-screen, which is what scrolling is.',
    ' const bodyTop = Math.round(body.getBoundingClientRect().top)',
    ' return JSON.stringify({',
    '  headerTop: Math.round(h.top), headerBottom: Math.round(h.bottom), bodyTop,',
    "  back: hit(header.querySelector('button')), chrome: hit(header.querySelector('.chrome')),",
    '  scrollTop: Math.round(body.scrollTop), clientHeight: Math.round(body.clientHeight),',
    '  scrollHeight: Math.round(body.scrollHeight) })',
    '})()'
  ].join('\n')
  const scrollTo = (to: string): string =>
    "(() => { const body = document.querySelector('.settings__body');" +
    ' if (body === null) return false; body.scrollTop = ' + to + '; return true })()'

  const read = async (): Promise<HeaderLayout> =>
    JSON.parse(String(await window.webContents.executeJavaScript(probe))) as HeaderLayout

  const before = await read()
  if (before.error !== undefined) return 'the settings page is missing its ' + before.error
  if (before.scrollHeight <= before.clientHeight) {
    return 'the settings page no longer overflows, so nothing proves the header stays put'
  }
  if ((await window.webContents.executeJavaScript(scrollTo('body.scrollHeight'))) !== true) {
    return 'the settings page has no scrolling body'
  }
  await delay(150)
  const after = await read()
  await window.webContents.executeJavaScript(scrollTo('0'))
  if (after.scrollTop <= 0) return 'the settings content did not scroll at all'
  if (after.headerTop !== before.headerTop) {
    return 'the header moved with the page (' + before.headerTop + ' -> ' + after.headerTop + ')'
  }
  if (after.back !== 'clickable') return 'the back button is ' + after.back + ' once the page is scrolled'
  if (after.chrome !== 'clickable') {
    return 'a window button is ' + after.chrome + ' once the page is scrolled'
  }
  if (after.bodyTop < after.headerBottom) {
    return 'the scrolling content starts under the header (' + after.bodyTop + ' < ' + after.headerBottom + ')'
  }
  console.log(
    'SMOKE_INFO settings-header=fixed, header=' +
      String(before.headerTop) +
      ', content-top=' +
      String(after.bodyTop)
  )
  return null
}

/**
 * The language layer, driven in the real app rather than in a unit test: the answer box is
 * labelled from the registry, the settings picker writes the pair through IPC, the panel
 * relabels itself, and the value survives in config.json. Switching the learning language to
 * French is the cheapest way to prove none of that is hardcoded to English.
 */
async function runLanguageFlow(window: BrowserWindow, config: ConfigStore): Promise<LanguageFlowResult> {
  const stop = (error: string, before = '', after = ''): LanguageFlowResult => ({ error, before, after })
  // The profile strip is built from the registry ("Native: ... · Learning: ...") and, unlike the
  // answer placeholder, is not replaced by the mock-mode banner.
  const directionText =
    "(() => { const found = document.querySelector('.modebar__profile');" +
    " return found === null ? '' : found.textContent })()"
  const englishLabels =
    "(() => { const found = document.querySelector('.modebar__profile');" +
    " return found !== null && found.textContent.includes('English') })()"
  if (!(await waitForRenderer(window, englishLabels))) {
    return stop(
      'the panel does not name the learning language (got ' +
        String(await window.webContents.executeJavaScript(directionText)) +
        ')'
    )
  }
  const before = String(await window.webContents.executeJavaScript(directionText))

  if (!(await clickButton(window, '设置'))) return stop('the settings button is missing', before)
  // Found by its own label rather than by any text the field contains: the native picker names the
  // language being learned too - as the option it cannot offer - so "contains this text" would
  // match the wrong picker.
  const learningField =
    "[...document.querySelectorAll('.field')].find((item) => { const label = item.querySelector('.field__label');" +
    " return label !== null && label.textContent.trim() === '正在学的语言' })"
  const picker =
    '(() => { const field = ' +
    learningField +
    ';' +
    " if (field === undefined) return false; const select = field.querySelector('select');" +
    " return select !== null && [...select.options].some((option) => option.value === 'fr') })()"
  if (!(await waitForRenderer(window, picker))) return stop('the language picker never appeared', before)

  // The page is at its full height here, which is the only moment this can be measured.
  const header = await verifyFixedHeader(window)
  if (header !== null) return stop(header, before)

  // A React-controlled select ignores a plain assignment, so use the native setter and
  // dispatch the same change event a real click would.
  const switchToFrench =
    '(() => { const field = ' +
    learningField +
    ';' +
    " const select = field.querySelector('select');" +
    " const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;" +
    " setter.call(select, 'fr'); select.dispatchEvent(new Event('change', { bubbles: true })); return true })()"
  await window.webContents.executeJavaScript(switchToFrench)
  if (!(await waitForStore(() => config.readPublicSettings().learningLanguage === 'fr'))) {
    return stop('the picker did not save the new learning language', before)
  }

  if (!(await clickButton(window, '返回'))) return stop('the back button is missing', before)
  if (!(await waitForSelector(window, '.assistant__title'))) {
    return stop('could not get back to the panel', before)
  }
  const frenchLabels =
    "(() => { const found = document.querySelector('.modebar__profile');" +
    " return found !== null && found.textContent.includes('Français') })()"
  if (!(await waitForRenderer(window, frenchLabels))) {
    return stop('the panel kept the old learning language', before)
  }
  const after = String(await window.webContents.executeJavaScript(directionText))
  return { error: null, before, after }
}

async function readActiveElement(window: BrowserWindow): Promise<string> {
  try {
    return String(
      await window.webContents.executeJavaScript(
        "(() => { const el = document.activeElement; return el === null ? 'none' : el.tagName + '.' + el.className })()"
      )
    )
  } catch {
    return 'unknown'
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
