// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicSettings } from '@shared/types'
import type { AssistantApi } from '@shared/types/api'
import type { BridgeStatus } from '@shared/types/bridge'
import type { UseBrowserBridgeResult } from '../hooks/useBrowserBridge'
import type { ShortcutEditor } from '../hooks/useGlobalShortcut'
import { SettingsForm } from './SettingsForm'

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

/** A bridge that is switched off and holding no port, which is what a fresh install has. */
function bridge(overrides: Partial<UseBrowserBridgeResult> = {}): UseBrowserBridgeResult {
  return {
    status: OFF_STATUS,
    errorMessage: null,
    resetToken: vi.fn(() => Promise.resolve()),
    ...overrides
  }
}

const OFF_STATUS: BridgeStatus = {
  policy: 'off',
  listening: false,
  port: null,
  token: '',
  lastRequestAt: null
}

/** A bridge that is switched on and holding a port, which is what pairing looks like from here. */
function onStatus(overrides: Partial<BridgeStatus> = {}): BridgeStatus {
  return {
    policy: 'on',
    listening: true,
    port: 43110,
    token: 'token-for-tests',
    lastRequestAt: null,
    ...overrides
  }
}

/** The same settings with the bridge switched on, so its fieldset is the one under test. */
const ON_SETTINGS: PublicSettings = { ...SETTINGS, browserBridgePolicy: 'on' }

function shortcutEditor(overrides: Partial<ShortcutEditor> = {}): ShortcutEditor {
  return {
    accelerator: 'CommandOrControl+Shift+Space',
    status: { ok: true, accelerator: 'CommandOrControl+Shift+Space', message: '' },
    applying: false,
    apply: vi.fn(() => Promise.resolve()),
    ...overrides
  }
}

/** One option of a picker, by value. Throws when the option is not rendered at all. */
function optionOf(select: HTMLSelectElement, code: string): HTMLOptionElement {
  const option = [...select.options].find((entry) => entry.value === code)
  if (option === undefined) throw new Error('the picker has no ' + code + ' option')
  return option
}

function setup(
  settings: PublicSettings = SETTINGS,
  shortcut: ShortcutEditor = shortcutEditor(),
  browser = bridge()
): ReturnType<typeof vi.fn> {
  const onSave = vi.fn(() => Promise.resolve())
  render(
    <SettingsForm
      settings={settings}
      saving={false}
      onSave={onSave}
      shortcut={shortcut}
      bridge={browser}
    />
  )
  return onSave
}

afterEach(() => {
  cleanup()
})

describe('SettingsForm', () => {
  it('shows the stored endpoint, model and provider', () => {
    setup()
    expect(screen.getByDisplayValue('https://api.example.com/v1')).toBeDefined()
    expect(screen.getByDisplayValue('test-model')).toBeDefined()
    expect(screen.getByDisplayValue('OpenAI 兼容 API')).toBeDefined()
  })

  it('never renders the stored API key', () => {
    setup()
    const keyField = screen.getByPlaceholderText('已保存（留空表示不修改）') as HTMLInputElement
    expect(keyField.value).toBe('')
  })

  it('saves a new key together with the endpoint and model', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    await user.clear(screen.getByDisplayValue('test-model'))
    await user.type(screen.getByPlaceholderText('已保存（留空表示不修改）'), 'sk-new-key')
    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(onSave).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      model: '',
      providerKind: 'openai-compatible',
      apiKey: 'sk-new-key'
    })
  })

  it('leaves the stored key alone when the field stays empty', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '保存' }))

    expect(onSave).toHaveBeenCalledWith({
      baseUrl: 'https://api.example.com/v1',
      model: 'test-model',
      providerKind: 'openai-compatible'
    })
  })

  it('clears a stored key explicitly', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '清除已保存的 Key' }))

    expect(onSave).toHaveBeenCalledWith({ apiKey: '' })
  })

  it('warns when the OS keyring is unavailable', () => {
    setup({ ...SETTINGS, apiKeyEncrypted: false })
    expect(screen.getByText(/明文保存在本机配置文件中/)).toBeDefined()
  })

  it('hides the clear button when nothing is stored', () => {
    setup({ ...SETTINGS, hasApiKey: false })
    expect(screen.queryByRole('button', { name: '清除已保存的 Key' })).toBeNull()
  })

  it('saves the floating ball toggle immediately', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    await user.click(screen.getByRole('checkbox', { name: /启用悬浮球/ }))

    expect(onSave).toHaveBeenCalledWith({ floatingBall: false })
  })

  it('saves the start-with-windows toggle immediately', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    await user.click(screen.getByRole('checkbox', { name: /开机自启/ }))

    expect(onSave).toHaveBeenCalledWith({ launchAtLogin: true })
  })

  it('starts the recent list off, and turns it on explicitly', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    // Off is the shipped state, so the switch has to read as off.
    const toggle = screen.getByRole('checkbox', { name: /在本机保留最近翻译/ }) as HTMLInputElement
    expect(toggle.checked).toBe(false)

    await user.click(toggle)

    expect(onSave).toHaveBeenCalledWith({ recentPolicy: 'on' })
  })

  it('turns the recent list back off without claiming it was erased', async () => {
    const onSave = setup({ ...SETTINGS, recentPolicy: 'on' })
    const user = userEvent.setup()

    const toggle = screen.getByRole('checkbox', { name: /在本机保留最近翻译/ })
    expect((toggle as HTMLInputElement).checked).toBe(true)

    await user.click(toggle)

    // Off only stops recording; the hint says so, because the rows already written stay put.
    expect(onSave).toHaveBeenCalledWith({ recentPolicy: 'off' })
    expect(screen.getByText(/关掉只是停止记录/)).toBeDefined()
  })

  it('saves the language pair from the pickers', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    await user.selectOptions(screen.getByDisplayValue('中文 / Chinese'), 'fr')
    expect(onSave).toHaveBeenCalledWith({ nativeLanguage: 'fr' })

    await user.selectOptions(screen.getByDisplayValue('English'), 'es')
    expect(onSave).toHaveBeenCalledWith({ learningLanguage: 'es' })
  })

  it('offers every supported language on both sides, including the shipped ones', () => {
    setup()
    const native = screen.getByDisplayValue('中文 / Chinese') as HTMLSelectElement
    const learning = screen.getByDisplayValue('English') as HTMLSelectElement

    expect(native.options).toHaveLength(6)
    expect(learning.options).toHaveLength(6)
    expect([...learning.options].map((option) => option.value)).toContain('ar')
    // An English speaker learning Chinese has to see both languages, not just the pair in use.
    expect(optionOf(native, 'en')).toBeDefined()
    expect(optionOf(learning, 'zh')).toBeDefined()
  })

  it('greys out the one language the other side is already using, and says why', () => {
    setup()
    const native = screen.getByDisplayValue('中文 / Chinese') as HTMLSelectElement
    const learning = screen.getByDisplayValue('English') as HTMLSelectElement

    // Disabled rather than missing: an absent option reads as "this language is not supported".
    expect(optionOf(native, 'en').disabled).toBe(true)
    expect(optionOf(native, 'en').textContent).toContain('正在学的语言')
    expect(optionOf(learning, 'zh').disabled).toBe(true)
    expect(optionOf(learning, 'zh').textContent).toContain('你的母语')
    // Every other language stays pickable from both sides.
    expect(optionOf(native, 'ar').disabled).toBe(false)
    expect(optionOf(learning, 'ar').disabled).toBe(false)
  })

  it('swaps the two sides in one save, which is how the blocked language is reached', async () => {
    const onSave = setup()
    const user = userEvent.setup()

    await user.click(screen.getByRole('button', { name: '⇄ 互换语言' }))

    expect(onSave).toHaveBeenCalledWith({ nativeLanguage: 'en', learningLanguage: 'zh' })
  })

  it('lets an English speaker learning Chinese see that pair the other way round', async () => {
    const onSave = setup({ ...SETTINGS, nativeLanguage: 'en', learningLanguage: 'zh' })
    const user = userEvent.setup()
    // 'English' is the native picker here, because that side is the one showing it.
    const native = screen.getByDisplayValue('English') as HTMLSelectElement

    expect(optionOf(native, 'zh').disabled).toBe(true)
    await user.selectOptions(native, 'fr')

    expect(onSave).toHaveBeenCalledWith({ nativeLanguage: 'fr' })
  })

  it('applies a new global shortcut', async () => {
    const apply = vi.fn(() => Promise.resolve())
    setup(SETTINGS, shortcutEditor({ apply }))
    const user = userEvent.setup()

    const field = screen.getByDisplayValue('CommandOrControl+Shift+Space')
    await user.clear(field)
    await user.type(field, 'Ctrl+Alt+Q')
    await user.click(screen.getByRole('button', { name: '应用' }))

    expect(apply).toHaveBeenCalledWith('Ctrl+Alt+Q')
  })

  it('shows why a shortcut could not be registered', () => {
    setup(
      SETTINGS,
      shortcutEditor({
        accelerator: 'CommandOrControl+Shift+Space',
        status: { ok: false, accelerator: 'CommandOrControl+Shift+Space', message: '这个快捷键已被其它程序占用，请换一个。' }
      })
    )

    expect(screen.getByText('这个快捷键已被其它程序占用，请换一个。')).toBeDefined()
  })

  it('stays off, and keeps the token out of sight, until it is switched on', () => {
    setup()

    expect(screen.getByText('状态：未开启')).toBeDefined()
    expect(screen.queryByText('连接口令')).toBeNull()
  })

  it('waits rather than claiming a connection no extension has made yet', () => {
    setup(ON_SETTINGS, shortcutEditor(), bridge({ status: onStatus() }))

    expect(screen.getByText('状态：等待浏览器扩展连接')).toBeDefined()
  })

  it('says when the extension last reached it, not just that it is connected', () => {
    // The status line is the only place a user can tell whether pasting the token worked, so the
    // answer has to be about the last time the extension actually spoke, not the port being open.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000 - 500).toISOString()
    setup(ON_SETTINGS, shortcutEditor(), bridge({ status: onStatus({ lastRequestAt: fiveMinutesAgo }) }))

    expect(screen.getByText('状态：已连接 · 上次使用：5 分钟前')).toBeDefined()
  })

  it('reports a taken port instead of pretending to be connected', () => {
    setup(
      ON_SETTINGS,
      shortcutEditor(),
      bridge({ status: onStatus({ listening: false, port: null }) })
    )

    expect(screen.getByText('状态：现在连不上：端口被别的程序占用了，重启一下这个软件再试')).toBeDefined()
  })

  it('writes out the steps, because an open port grows no extension by itself', () => {
    setup(ON_SETTINGS, shortcutEditor(), bridge({ status: onStatus() }))

    expect(screen.getByText(/浏览器地址栏粘贴 chrome:\/\/extensions/)).toBeDefined()
    expect(screen.getByText(/点「加载已解压的扩展程序」/)).toBeDefined()
    // The floating card only appears after Ctrl+Shift, so the step has to say so; the right-click
    // entry is the one a user finds without knowing that, so it is named in the same step.
    expect(screen.getByText(/按住 Ctrl\+Shift 划词/)).toBeDefined()
    expect(screen.getByText(/点浮层底部的「学习这句」/)).toBeDefined()
    expect(screen.getByText(/发送到 AI Language Coach（学习这句）/)).toBeDefined()
  })

  it('says the token was copied instead of leaving the button silent', async () => {
    // A copy button that answers with nothing leaves the user unsure whether it worked, and this
    // is the one button standing between them and a paired extension.
    const user = userEvent.setup()
    const copyText = vi.fn(() => Promise.resolve(true))
    window.api = { copyText } as unknown as AssistantApi
    try {
      setup(ON_SETTINGS, shortcutEditor(), bridge({ status: onStatus() }))

      await user.click(screen.getByRole('button', { name: '复制口令' }))

      expect(copyText).toHaveBeenCalledWith('token-for-tests')
      expect(screen.getByRole('button', { name: '已复制' })).toBeDefined()
    } finally {
      delete window.api
    }
  })
})
