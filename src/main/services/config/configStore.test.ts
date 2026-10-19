import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BROWSER_BRIDGE_POLICY } from '@shared/types'
import { ConfigStore } from './configStore'

// Only the default path and the API key use Electron; these tests pass an explicit file, and the
// keyring is reported unavailable so a key is stored the way it is when DPAPI is missing.
vi.mock('electron', () => ({
  app: { getPath: () => 'test-user-data' },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctoe-config-'))
  dirs.push(dir)
  return join(dir, 'config.json')
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('ConfigStore: the shipped pair', () => {
  it('starts from the shipped settings when there is no file yet', () => {
    const settings = ConfigStore.open(tempFile()).readPublicSettings()

    expect(settings).toMatchObject({
      nativeLanguage: 'zh',
      learningLanguage: 'en',
      tone: 'natural',
      providerKind: 'openai-compatible',
      hasApiKey: false,
      floatingBall: true,
      launchAtLogin: false,
      // Opt-in, so the shipped state keeps nothing.
      recentPolicy: 'off'
    })
  })

  it('repairs a file that names one language on both sides', () => {
    // Nothing can be translated inside one language, so the app runs with the side the user speaks
    // and moves the learned side - here to the other half of the shipped pair.
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ nativeLanguage: 'en', learningLanguage: 'en' }), 'utf8')

    expect(ConfigStore.open(file).readPublicSettings()).toMatchObject({
      nativeLanguage: 'en',
      learningLanguage: 'zh'
    })
    // Read-only repair: the file is left exactly as it was, and rewritten on the next save.
    expect(JSON.parse(readFileSync(file, 'utf8')).learningLanguage).toBe('en')
  })

  it('falls back to the shipped pair when the stored one is the same language twice', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ nativeLanguage: 'zh', learningLanguage: 'zh' }), 'utf8')

    expect(ConfigStore.open(file).readPublicSettings()).toMatchObject({
      nativeLanguage: 'zh',
      learningLanguage: 'en'
    })
  })

  it('keeps a pair that was stored by hand', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ nativeLanguage: 'fr', learningLanguage: 'es' }), 'utf8')

    expect(ConfigStore.open(file).readPublicSettings()).toMatchObject({
      nativeLanguage: 'fr',
      learningLanguage: 'es'
    })
  })
})

describe('ConfigStore: moving the two languages', () => {
  it('moves both sides when the patch is a real relation', () => {
    const file = tempFile()
    const store = ConfigStore.open(file)

    const after = store.updateSettings({ nativeLanguage: 'es', learningLanguage: 'fr' })

    expect(after).toMatchObject({ nativeLanguage: 'es', learningLanguage: 'fr' })
    // Persisted, not just held in memory: the pickers read the file back on the next launch.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      nativeLanguage: 'es',
      learningLanguage: 'fr'
    })
  })

  it('swaps the two sides in one patch, which is what the picker offers', () => {
    const store = ConfigStore.open(tempFile())

    expect(store.updateSettings({ nativeLanguage: 'en', learningLanguage: 'zh' })).toMatchObject({
      nativeLanguage: 'en',
      learningLanguage: 'zh'
    })
  })

  it('refuses a learning language that is already the native one', () => {
    // A language on both sides is not a relation: there would be nothing to translate.
    const store = ConfigStore.open(tempFile())

    const after = store.updateSettings({ learningLanguage: 'zh' })

    expect(after).toMatchObject({ nativeLanguage: 'zh', learningLanguage: 'en' })
  })

  it('refuses a native language that is already the learning one', () => {
    const store = ConfigStore.open(tempFile())

    const after = store.updateSettings({ nativeLanguage: 'en' })

    expect(after).toMatchObject({ nativeLanguage: 'zh', learningLanguage: 'en' })
  })

  it('drops both halves when one patch asks for the same language twice', () => {
    const store = ConfigStore.open(tempFile())
    store.updateSettings({ nativeLanguage: 'fr', learningLanguage: 'es' })

    const after = store.updateSettings({ nativeLanguage: 'ru', learningLanguage: 'ru' })

    expect(after).toMatchObject({ nativeLanguage: 'fr', learningLanguage: 'es' })
  })

  it('ignores a language the registry does not have', () => {
    const store = ConfigStore.open(tempFile())

    const after = store.updateSettings({ nativeLanguage: 'klingon' as never })

    expect(after).toMatchObject({ nativeLanguage: 'zh', learningLanguage: 'en' })
  })
})

describe('ConfigStore: the recent list is opt-in', () => {
  it('ships off, which is what keeps the app from recording anything', () => {
    expect(ConfigStore.open(tempFile()).readPublicSettings().recentPolicy).toBe('off')
  })

  it('remembers an answer either way, and writes it to the file', () => {
    const file = tempFile()
    const store = ConfigStore.open(file)

    expect(store.updateSettings({ recentPolicy: 'on' }).recentPolicy).toBe('on')
    // Persisted, so the answer survives a restart instead of being asked again.
    expect(JSON.parse(readFileSync(file, 'utf8')).recentPolicy).toBe('on')
    expect(store.updateSettings({ recentPolicy: 'off' }).recentPolicy).toBe('off')
  })

  it('ignores a value that is not one of the two, wherever it came from', () => {
    const store = ConfigStore.open(tempFile())
    expect(store.updateSettings({ recentPolicy: 'sometimes' as never }).recentPolicy).toBe('off')

    // And a hand-edited file cannot promote itself into recording.
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ recentPolicy: 'yes' }), 'utf8')
    expect(ConfigStore.open(file).readPublicSettings().recentPolicy).toBe('off')
  })

  /**
   * Files written before this state was retired still say 'unasked' on disk, and plenty of them
   * are sitting on real machines. It always meant "off", so it has to keep reading as off - and
   * the file must survive being opened, because nothing here is the user's answer to rewrite.
   */
  it('reads the retired state as off, without rewriting the file', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ recentPolicy: 'unasked' }), 'utf8')

    expect(ConfigStore.open(file).readPublicSettings().recentPolicy).toBe('off')
    expect(JSON.parse(readFileSync(file, 'utf8')).recentPolicy).toBe('unasked')
  })
})

describe('ConfigStore: the browser bridge is opt-in', () => {
  it('ships off, which is what keeps the port closed', () => {
    expect(ConfigStore.open(tempFile()).readPublicSettings().browserBridgePolicy).toBe(
      DEFAULT_BROWSER_BRIDGE_POLICY
    )
  })

  it('remembers an answer either way, and writes it to the file', () => {
    const file = tempFile()
    const store = ConfigStore.open(file)

    expect(store.updateSettings({ browserBridgePolicy: 'on' }).browserBridgePolicy).toBe('on')
    expect(JSON.parse(readFileSync(file, 'utf8')).browserBridgePolicy).toBe('on')
    expect(store.updateSettings({ browserBridgePolicy: 'off' }).browserBridgePolicy).toBe('off')
  })

  it('ignores a value that is not one of the two, wherever it came from', () => {
    const store = ConfigStore.open(tempFile())
    expect(
      store.updateSettings({ browserBridgePolicy: 'maybe' as never }).browserBridgePolicy
    ).toBe('off')

    // A hand-edited file cannot promote itself into listening either.
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ browserBridgePolicy: true }), 'utf8')
    expect(ConfigStore.open(file).readPublicSettings().browserBridgePolicy).toBe('off')
  })

  // Same retired state, same rule: an existing file that still holds it reads as off and is not
  // rewritten just because the app looked at it.
  it('reads the retired state as off, without rewriting the file', () => {
    const file = tempFile()
    writeFileSync(file, JSON.stringify({ browserBridgePolicy: 'unasked' }), 'utf8')

    expect(ConfigStore.open(file).readPublicSettings().browserBridgePolicy).toBe('off')
    expect(JSON.parse(readFileSync(file, 'utf8')).browserBridgePolicy).toBe('unasked')
  })
})

describe('ConfigStore: the pairing token', () => {
  it('has none until one is minted, and remembers the one it is given', () => {
    const file = tempFile()
    const store = ConfigStore.open(file)

    expect(store.readBridgeToken()).toBe('')
    store.writeBridgeToken('a'.repeat(64))
    expect(store.readBridgeToken()).toBe('a'.repeat(64))
    // On disk, so a paired extension keeps working after a restart.
    expect(JSON.parse(readFileSync(file, 'utf8')).bridgeToken).toBeDefined()
  })

  it('replaces the token when a new one is written, which is what a reset does', () => {
    const store = ConfigStore.open(tempFile())
    store.writeBridgeToken('first')
    store.writeBridgeToken('second')
    expect(store.readBridgeToken()).toBe('second')
  })
})

describe('ConfigStore: when the bridge last heard from a paired extension', () => {
  const AT = '2026-09-30T12:00:00.000Z'

  it('has none until one is recorded, and keeps it across a restart', () => {
    const file = tempFile()
    const store = ConfigStore.open(file)
    expect(store.readBridgeLastRequestAt()).toBeNull()

    store.writeBridgeLastRequestAt(AT)

    expect(store.readBridgeLastRequestAt()).toBe(AT)
    // On disk, so "connected" outlives the process that saw the request - which is the whole
    // point of recording it.
    expect(ConfigStore.open(file).readBridgeLastRequestAt()).toBe(AT)
  })

  it('forgets it when the pairing is reset, since that is what unpairs the extension', () => {
    const file = tempFile()
    const store = ConfigStore.open(file)
    store.writeBridgeLastRequestAt(AT)

    store.clearBridgeLastRequestAt()

    expect(store.readBridgeLastRequestAt()).toBeNull()
    expect(JSON.parse(readFileSync(file, 'utf8')).bridgeLastRequestAt).toBeUndefined()
  })
})
