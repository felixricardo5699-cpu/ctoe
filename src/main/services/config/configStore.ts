import { app, safeStorage } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_GLOBAL_SHORTCUT, SETTINGS_DEFAULTS } from '@shared/config/defaults'
import { isUsablePair } from '@shared/language/pair'
import {
  DEFAULT_LEARNING_LANGUAGE,
  DEFAULT_NATIVE_LANGUAGE,
  LANGUAGE_CODES,
  isLanguageCode,
  type LanguageCode
} from '@shared/language/registry'
import {
  DEFAULT_BROWSER_BRIDGE_POLICY,
  DEFAULT_RECENT_POLICY,
  DEFAULT_TONE,
  isBrowserBridgePolicy,
  isProviderKind,
  isRecentPolicy,
  isTone,
  type BrowserBridgePolicy,
  type PanelSize,
  type ProviderKind,
  type ProviderSettings,
  type PublicSettings,
  type RecentPolicy,
  type SettingsPatch,
  type Tone,
  type Vec2
} from '@shared/types'

const CONFIG_VERSION = 2
const CONFIG_FILE_NAME = 'config.json'

interface StoredSecret {
  value: string
  /** false only when the OS keyring is unavailable (then it is plain text on disk). */
  encrypted: boolean
}

interface StoredConfig {
  version: number
  baseUrl: string
  model: string
  tone: Tone
  /** The user's own language: what coaching answers are written in. */
  nativeLanguage: LanguageCode
  /** The language they are learning. Together these two replace any fixed zh -> en pair. */
  learningLanguage: LanguageCode
  providerKind: ProviderKind
  apiKey?: StoredSecret
  /** Size of the expanded panel. */
  panel?: PanelSize
  /** Position of the floating ball. */
  ball?: Vec2
  floatingBall: boolean
  globalShortcut: string
  launchAtLogin: boolean
  /**
   * Whether translations are remembered locally. Kept here rather than with the recent file
   * itself, so 'never asked' survives without a file of its own - and so turning it off leaves
   * the rows alone until the user clears them.
   */
  recentPolicy: RecentPolicy
  /** Whether the browser bridge may listen at all; see BrowserBridgePolicy. */
  browserBridgePolicy: BrowserBridgePolicy
  /**
   * The shared secret the browser extension pairs with, encrypted with the OS keyring exactly
   * like the API key. Absent means "never minted", which the bridge service reads as "make one".
   */
  bridgeToken?: StoredSecret
  /**
   * When a paired extension last reached the bridge, as an ISO-8601 string. Kept on disk rather
   * than in memory so that "connected" survives a restart - which is the difference between "no
   * extension has ever paired" and "the one you paired yesterday is still working".
   */
  bridgeLastRequestAt?: string
}

/**
 * Tiny JSON store in the OS app-data directory. Deliberately not a settings
 * framework: a handful of values do not need one.
 * The API key is encrypted with the OS keyring (DPAPI on Windows) when available.
 */
export class ConfigStore {
  private constructor(
    private readonly filePath: string,
    private data: StoredConfig
  ) {}

  static open(filePath: string = join(app.getPath('userData'), CONFIG_FILE_NAME)): ConfigStore {
    return new ConfigStore(filePath, readStoredConfig(filePath))
  }

  get path(): string {
    return this.filePath
  }

  readPublicSettings(): PublicSettings {
    return {
      baseUrl: this.data.baseUrl,
      model: this.data.model,
      tone: this.data.tone,
      nativeLanguage: this.data.nativeLanguage,
      learningLanguage: this.data.learningLanguage,
      providerKind: this.data.providerKind,
      hasApiKey: this.data.apiKey !== undefined,
      apiKeyEncrypted: this.data.apiKey?.encrypted ?? true,
      floatingBall: this.data.floatingBall,
      globalShortcut: this.data.globalShortcut,
      launchAtLogin: this.data.launchAtLogin,
      recentPolicy: this.data.recentPolicy,
      browserBridgePolicy: this.data.browserBridgePolicy
    }
  }

  /** null when nothing usable is stored; the provider factory turns that into a friendly error. */
  readProviderSettings(): ProviderSettings | null {
    const secret = this.data.apiKey
    if (secret === undefined) return null
    return {
      baseUrl: this.data.baseUrl,
      model: this.data.model,
      apiKey: decryptSecret(secret)
    }
  }

  updateSettings(patch: SettingsPatch): PublicSettings {
    if (patch.baseUrl !== undefined) {
      this.data.baseUrl = patch.baseUrl.trim().length > 0 ? patch.baseUrl.trim() : SETTINGS_DEFAULTS.baseUrl
    }
    if (patch.model !== undefined) {
      this.data.model = patch.model.trim().length > 0 ? patch.model.trim() : SETTINGS_DEFAULTS.model
    }
    if (patch.tone !== undefined && isTone(patch.tone)) this.data.tone = patch.tone
    this.moveLanguages(patch)
    if (patch.providerKind !== undefined && isProviderKind(patch.providerKind)) {
      this.data.providerKind = patch.providerKind
    }
    if (patch.floatingBall !== undefined) this.data.floatingBall = patch.floatingBall
    if (patch.launchAtLogin !== undefined) this.data.launchAtLogin = patch.launchAtLogin
    // Opt-in either way, and only ever written by an explicit answer: a patch that does not name
    // a policy leaves the stored one alone.
    if (isRecentPolicy(patch.recentPolicy)) this.data.recentPolicy = patch.recentPolicy
    // Same rule as the recent list: the bridge moves only when the user says so.
    if (isBrowserBridgePolicy(patch.browserBridgePolicy)) {
      this.data.browserBridgePolicy = patch.browserBridgePolicy
    }
    if (patch.apiKey !== undefined) {
      const apiKey = patch.apiKey.trim()
      if (apiKey.length === 0) delete this.data.apiKey
      else this.data.apiKey = encryptSecret(apiKey)
    }
    this.persist()
    return this.readPublicSettings()
  }

  /**
   * Moves the two languages a patch asked for, minus any half that would put one language on both
   * sides of the relation.
   *
   * The store is the last line here rather than the picker: a patch can come from anywhere, and a
   * pair with the same language twice would leave the app with nothing to translate for good. A
   * patch that would produce one is dropped whole, so the caller reads the pair it still has back
   * out of the returned settings and the two pickers snap back to it.
   */
  private moveLanguages(patch: SettingsPatch): void {
    const nativeLanguage = isLanguageCode(patch.nativeLanguage) ? patch.nativeLanguage : undefined
    const learningLanguage = isLanguageCode(patch.learningLanguage)
      ? patch.learningLanguage
      : undefined
    const nextNative = nativeLanguage ?? this.data.nativeLanguage
    const nextLearning = learningLanguage ?? this.data.learningLanguage
    if (!isUsablePair(nextNative, nextLearning)) return
    if (nativeLanguage !== undefined) this.data.nativeLanguage = nativeLanguage
    if (learningLanguage !== undefined) this.data.learningLanguage = learningLanguage
  }

  /**
   * Stored separately from updateSettings because registration can fail: the caller
   * only persists the accelerator once the OS actually accepted it.
   */
  setGlobalShortcut(accelerator: string): PublicSettings {
    this.data.globalShortcut = accelerator.trim().length > 0 ? accelerator.trim() : DEFAULT_GLOBAL_SHORTCUT
    this.persist()
    return this.readPublicSettings()
  }

  /**
   * The pairing token, or '' when none was ever minted. The bridge mints one on first need and
   * writes it back, so the secret outlives the process and a paired extension keeps working.
   */
  readBridgeToken(): string {
    const secret = this.data.bridgeToken
    return secret === undefined ? '' : decryptSecret(secret)
  }

  /** Stores a freshly minted token. Replacing one is the user pressing "reset". */
  writeBridgeToken(token: string): void {
    this.data.bridgeToken = encryptSecret(token)
    this.persist()
  }

  /**
   * When a paired extension last spoke, or null when none ever has.
   *
   * Only requests that carried the right token are recorded here, so a page that merely asks
   * whether the app is listening cannot make the settings page claim a connection it does not
   * have - and neither can any other program on this machine.
   */
  readBridgeLastRequestAt(): string | null {
    return this.data.bridgeLastRequestAt ?? null
  }

  /** Records a request that got past the token check. */
  writeBridgeLastRequestAt(at: string): void {
    this.data.bridgeLastRequestAt = at
    this.persist()
  }

  /** Forgets it. Reset unpairs the extension, so the record of the old pairing goes with it. */
  clearBridgeLastRequestAt(): void {
    if (this.data.bridgeLastRequestAt === undefined) return
    delete this.data.bridgeLastRequestAt
    this.persist()
  }

  readPanelSize(): PanelSize | null {
    return this.data.panel ?? null
  }

  writePanelSize(size: PanelSize): void {
    this.data.panel = size
    this.persist()
  }

  readBallPosition(): Vec2 | null {
    return this.data.ball ?? null
  }

  writeBallPosition(position: Vec2): void {
    this.data.ball = position
    this.persist()
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600
    })
  }
}

function encryptSecret(value: string): StoredSecret {
  if (safeStorage.isEncryptionAvailable()) {
    return { value: safeStorage.encryptString(value).toString('base64'), encrypted: true }
  }
  return { value, encrypted: false }
}

function decryptSecret(secret: StoredSecret): string {
  if (!secret.encrypted) return secret.value
  try {
    return safeStorage.decryptString(Buffer.from(secret.value, 'base64'))
  } catch {
    // Keyring changed or the blob was tampered with; behave like "no key stored".
    return ''
  }
}

function readStoredConfig(filePath: string): StoredConfig {
  const defaults: StoredConfig = {
    version: CONFIG_VERSION,
    baseUrl: SETTINGS_DEFAULTS.baseUrl,
    model: SETTINGS_DEFAULTS.model,
    tone: DEFAULT_TONE,
    nativeLanguage: DEFAULT_NATIVE_LANGUAGE,
    learningLanguage: DEFAULT_LEARNING_LANGUAGE,
    providerKind: 'openai-compatible',
    floatingBall: true,
    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
    launchAtLogin: false,
    recentPolicy: DEFAULT_RECENT_POLICY,
    browserBridgePolicy: DEFAULT_BROWSER_BRIDGE_POLICY
  }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return defaults
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return defaults
  }
  if (typeof parsed !== 'object' || parsed === null) return defaults
  const source = parsed as Record<string, unknown>
  const panel = readPanelSize(source)
  const ball = readVec2(source.ball)
  const bridgeLastRequestAt = readTimestamp(source.bridgeLastRequestAt)
  const nativeLanguage = isLanguageCode(source.nativeLanguage)
    ? source.nativeLanguage
    : defaults.nativeLanguage
  return {
    version: CONFIG_VERSION,
    baseUrl: readString(source, 'baseUrl', defaults.baseUrl),
    model: readString(source, 'model', defaults.model),
    tone: isTone(source.tone) ? source.tone : defaults.tone,
    nativeLanguage,
    learningLanguage: readLearningLanguage(
      source.learningLanguage,
      nativeLanguage,
      defaults.learningLanguage
    ),
    providerKind: isProviderKind(source.providerKind) ? source.providerKind : defaults.providerKind,
    floatingBall: typeof source.floatingBall === 'boolean' ? source.floatingBall : defaults.floatingBall,
    globalShortcut: readString(source, 'globalShortcut', defaults.globalShortcut),
    launchAtLogin: typeof source.launchAtLogin === 'boolean' ? source.launchAtLogin : defaults.launchAtLogin,
    recentPolicy: readRecentPolicy(source.recentPolicy),
    browserBridgePolicy: readBrowserBridgePolicy(source.browserBridgePolicy),
    ...(readSecret(source.apiKey) !== undefined ? { apiKey: readSecret(source.apiKey) } : {}),
    ...(readSecret(source.bridgeToken) !== undefined
      ? { bridgeToken: readSecret(source.bridgeToken) }
      : {}),
    ...(panel !== null ? { panel } : {}),
    ...(ball !== null ? { ball } : {}),
    ...(bridgeLastRequestAt !== undefined ? { bridgeLastRequestAt } : {})
  }
}

/**
 * A policy read out of a file written before the third state was removed.
 *
 * Those files held 'unasked' for the shipped state, and it always behaved exactly like 'off' -
 * nothing was recorded, nothing was listening. So it is read as 'off' rather than being left to
 * the fallback, which is what lets an existing config.json keep working untouched: the file is
 * only rewritten the next time the user actually saves a setting.
 */
const LEGACY_UNASKED = 'unasked'

function readRecentPolicy(value: unknown): RecentPolicy {
  if (value === LEGACY_UNASKED) return 'off'
  return isRecentPolicy(value) ? value : DEFAULT_RECENT_POLICY
}

function readBrowserBridgePolicy(value: unknown): BrowserBridgePolicy {
  if (value === LEGACY_UNASKED) return 'off'
  return isBrowserBridgePolicy(value) ? value : DEFAULT_BROWSER_BRIDGE_POLICY
}

/**
 * The language being learned, with a file that names one language on both sides repaired.
 *
 * Nothing can be translated inside a single language, and no picker path can produce such a pair
 * any more, so a file holding one was edited by hand or written by something outside this app. The
 * side the user speaks is kept and the learned side moves to the shipped default - or, when that is
 * the language they speak, to the first language that is not their own. Nothing is written back:
 * the repair is what the app runs with, and the pair is stored the next time a setting is saved.
 */
function readLearningLanguage(
  value: unknown,
  nativeLanguage: LanguageCode,
  fallback: LanguageCode
): LanguageCode {
  const stored = isLanguageCode(value) ? value : fallback
  if (isUsablePair(nativeLanguage, stored)) return stored
  if (isUsablePair(nativeLanguage, fallback)) return fallback
  return LANGUAGE_CODES.find((code) => isUsablePair(nativeLanguage, code)) ?? stored
}

function readString(source: Record<string, unknown>, key: string, fallback: string): string {
  const value = source[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback
}

/** An ISO-8601 string out of the file, or undefined when there is nothing usable there. */
function readTimestamp(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function readSecret(value: unknown): StoredSecret | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value as Record<string, unknown>
  if (typeof source.value !== 'string' || source.value.length === 0) return undefined
  return { value: source.value, encrypted: source.encrypted === true }
}

function readVec2(value: unknown): Vec2 | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  const x = source.x
  const y = source.y
  if (typeof x !== 'number' || typeof y !== 'number') return null
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.round(x), y: Math.round(y) }
}

/**
 * v1 stored the (then framed) window size under "window"; that layout is gone, so a
 * legacy value is read as the panel size and rewritten under "panel" on next save.
 */
function readPanelSize(source: Record<string, unknown>): PanelSize | null {
  const direct = readSize(source.panel)
  if (direct !== null) return direct
  return readSize(source.window)
}

function readSize(value: unknown): PanelSize | null {
  if (typeof value !== 'object' || value === null) return null
  const source = value as Record<string, unknown>
  const width = source.width
  const height = source.height
  if (typeof width !== 'number' || typeof height !== 'number') return null
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  return { width: Math.round(width), height: Math.round(height) }
}
