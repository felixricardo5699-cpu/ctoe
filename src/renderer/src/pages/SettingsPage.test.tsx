// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AssistantApi } from '@shared/types/api'
import type { PublicSettings } from '@shared/types'
import { SettingsPage } from './SettingsPage'

const SETTINGS: PublicSettings = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  tone: 'natural',
  providerKind: 'openai-compatible',
  nativeLanguage: 'zh',
  learningLanguage: 'en',
  hasApiKey: true,
  apiKeyEncrypted: true,
  floatingBall: true,
  globalShortcut: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  recentPolicy: 'off',
  browserBridgePolicy: 'off'
}

const CTOE_DATA = 'C:/Users/me/AppData/Roaming/ctoe'

/** Only what this page actually calls: the rest of the surface is not its business. */
function createApi(overrides: Record<string, unknown> = {}): AssistantApi {
  const stub = {
    getSettings: () => Promise.resolve(SETTINGS),
    saveSettings: () => Promise.resolve(SETTINGS),
    getAppInfo: () =>
      Promise.resolve({
        version: '0.1.1',
        platform: 'win32',
        configPath: 'C:/Users/me/AppData/Roaming/ctoe/config.json'
      }),
    copyText: () => Promise.resolve(true),
    openExtensionFolder: () => Promise.resolve({ ok: true, folder: null, message: '' }),
    openDataFolder: () => Promise.resolve({ ok: true, folder: CTOE_DATA, message: '' }),
    getShortcutStatus: () => Promise.resolve({ ok: true, accelerator: '', message: '' }),
    setShortcut: () => Promise.resolve({ ok: true, accelerator: '', message: '' }),
    onShortcutStatus: () => () => undefined,
    getBridgeStatus: () =>
      Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    resetBridgeToken: () =>
      Promise.resolve({ policy: 'off', listening: false, port: null, token: '', lastRequestAt: null }),
    onBridgeStatus: () => () => undefined
  }
  return { ...stub, ...overrides } as unknown as AssistantApi
}

function setup(api: AssistantApi): void {
  window.api = api
  render(
    <SettingsPage
      settings={SETTINGS}
      saving={false}
      errorMessage={null}
      onSave={() => Promise.resolve()}
      onBack={vi.fn()}
    />
  )
}

afterEach(() => {
  cleanup()
  delete (window as { api?: AssistantApi }).api
})

describe('SettingsPage: where the data lives', () => {
  it('names the folder the app keeps its files in', async () => {
    setup(createApi())

    // "Where is my data" is a question people arrive with, so the path is on screen before they
    // have to click anything - derived from the config path the main process already reports.
    expect(await screen.findByText(CTOE_DATA)).toBeDefined()
  })

  it('opens that folder on request', async () => {
    const user = userEvent.setup()
    const openDataFolder = vi.fn(() => Promise.resolve({ ok: true, folder: CTOE_DATA, message: '' }))
    setup(createApi({ openDataFolder }))

    await user.click(screen.getByRole('button', { name: '打开数据文件夹' }))

    expect(openDataFolder).toHaveBeenCalledTimes(1)
  })

  it('says why when the folder could not be opened', async () => {
    const user = userEvent.setup()
    setup(
      createApi({
        openDataFolder: () =>
          Promise.resolve({ ok: false, folder: CTOE_DATA, message: 'no file manager' })
      })
    )

    await user.click(screen.getByRole('button', { name: '打开数据文件夹' }))

    expect(await screen.findByText('no file manager')).toBeDefined()
  })
})
