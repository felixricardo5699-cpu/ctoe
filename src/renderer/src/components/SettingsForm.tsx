import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react'
import {
  SUPPORTED_LANGUAGES,
  isLanguageCode,
  type Language,
  type LanguageCode
} from '@shared/language/registry'
import {
  PROVIDER_KINDS,
  PROVIDER_LABELS,
  isProviderKind,
  type ProviderKind,
  type PublicSettings,
  type SettingsPatch
} from '@shared/types'
import type { UseBrowserBridgeResult } from '../hooks/useBrowserBridge'
import type { ShortcutEditor } from '../hooks/useGlobalShortcut'
import { assistantApi } from '../services/assistantApi'
import { relativeTimeLabel } from '../utils/relativeTime'

/**
 * What the settings page says about the bridge, in the user's own terms.
 *
 * A bridge that is on but never reached is the normal state right after switching it on, so it
 * says "waiting" rather than claiming to be connected: an extension has to be pointed at it first,
 * and pretending otherwise would make a working feature look broken.
 */
function bridgeStateLabel(bridge: UseBrowserBridgeResult, now: number = Date.now()): string {
  const status = bridge.status
  if (status === null) return '正在读取…'
  // Off is the shipped state as well as the switched-off one: the switch beside this line says
  // which, so the status line only has to say the bridge is not up.
  if (status.policy === 'off') return '未开启'
  // Switched on but holding no port: something else on this machine is using all of them.
  // 端口号对用户没有意义，所以这里只说"现在连不上"，并给出唯一一个他自己能做的动作。
  if (!status.listening || status.port === null) return '现在连不上：端口被别的程序占用了，重启一下这个软件再试'
  if (status.lastRequestAt === null) return '等待浏览器扩展连接'
  // '已连接' alone would be the same words a second after pairing and a week later. When the
  // extension last spoke is the part that tells the user whether pairing actually worked.
  const since = relativeTimeLabel(status.lastRequestAt, now)
  return '已连接' + (since === '' ? '' : ' · 上次使用：' + since)
}

/** '中文 / Chinese' for a language with its own script, plain 'English' when it has none. */
function languageOptionLabel(language: Language): string {
  return language.name === language.nativeName ? language.name : language.nativeName + ' / ' + language.name
}

interface SettingsFormProps {
  settings: PublicSettings
  saving: boolean
  onSave: (patch: SettingsPatch) => Promise<void>
  shortcut: ShortcutEditor
  /** The browser bridge's own state, read from the main process rather than derived here. */
  bridge: UseBrowserBridgeResult
}

export function SettingsForm({
  settings,
  saving,
  onSave,
  shortcut,
  bridge
}: SettingsFormProps): ReactElement {
  const [baseUrl, setBaseUrl] = useState(settings.baseUrl)
  const [model, setModel] = useState(settings.model)
  const [providerKind, setProviderKind] = useState<ProviderKind>(settings.providerKind)
  const [apiKey, setApiKey] = useState('')
  const [extensionNote, setExtensionNote] = useState<string | null>(null)
  const [accelerator, setAccelerator] = useState(shortcut.accelerator)

  // 复制口令这个按钮只说一句话，所以它得把结果说出来：复制成功就把标签翻成「已复制」
  // 一小会儿，否则用户不知道该不该再按一次。
  const [tokenCopied, setTokenCopied] = useState(false)
  useEffect(() => {
    if (!tokenCopied) return undefined
    const timer = window.setTimeout(() => setTokenCopied(false), 1400)
    return () => window.clearTimeout(timer)
  }, [tokenCopied])

  // Re-sync whenever the stored settings change (e.g. right after a save).
  useEffect(() => {
    setBaseUrl(settings.baseUrl)
    setModel(settings.model)
    setProviderKind(settings.providerKind)
  }, [settings.baseUrl, settings.model, settings.providerKind])

  // The main process may reject a shortcut and keep the previous one, so the field
  // always falls back to whatever is actually registered.
  useEffect(() => {
    setAccelerator(shortcut.accelerator)
  }, [shortcut.accelerator])

  const handleProviderChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = event.target.value
    if (isProviderKind(next)) setProviderKind(next)
  }

  /**
   * Puts the two sides the other way round. It is also the only way to hand one side the language
   * the other side is using right now - the picker greys that one out rather than hiding it, so
   * the reason stays visible.
   */
  const handleSwap = (): void => {
    void onSave({
      nativeLanguage: settings.learningLanguage,
      learningLanguage: settings.nativeLanguage
    })
  }

  // Saving on change matches the window toggles: there is nothing to type here, so a
  // separate submit would only be one more click.
  const saveLanguage = (value: string, side: 'native' | 'learning'): void => {
    if (!isLanguageCode(value)) return
    const patch: SettingsPatch = {}
    const code: LanguageCode = value
    if (side === 'native') patch.nativeLanguage = code
    else patch.learningLanguage = code
    void onSave(patch)
  }

  /**
   * 打开随安装包一起分发的扩展文件夹。桌面端不替用户安装扩展（浏览器也不允许），
   * 它能做的是把文件夹摆到用户眼前，所以结果只有"打开了"和"打不开、原因是……"。
   */
  const revealExtension = async (): Promise<void> => {
    try {
      const result = await assistantApi().openExtensionFolder()
      setExtensionNote(result.ok ? '已打开：' + (result.folder ?? '') : '打不开：' + result.message)
    } catch {
      setExtensionNote('打不开扩展文件夹，请手动到程序目录的 resources/extension 里找。')
    }
  }

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const patch: SettingsPatch = { baseUrl, model, providerKind }
    // A blank field means "keep the stored key"; clearing it is a separate action.
    if (apiKey.trim().length > 0) patch.apiKey = apiKey
    void onSave(patch).then(() => setApiKey(''))
  }

  const shortcutMessage =
    shortcut.status === null
      ? ''
      : shortcut.status.ok
        ? '已生效：' + shortcut.status.accelerator
        : shortcut.status.message

  return (
    <form className="settings__form" onSubmit={handleSubmit}>
      <fieldset className="settings__group">
        <legend className="settings__legend">AI 服务</legend>
        <label className="field">
          <span className="field__label">API Key</span>
          <input
            className="field__input"
            type="password"
            value={apiKey}
            autoComplete="off"
            spellCheck={false}
            placeholder={settings.hasApiKey ? '已保存（留空表示不修改）' : '还没有填，生成之前要填这里'}
            onChange={(event) => setApiKey(event.target.value)}
          />
          <span className="field__hint">只保存在本机，不会提交到 Git、也不会写进日志。没有它，第一次点 Generate 会直接失败。</span>
        </label>
        <span className="field__hint">
          还没有 Key？到
          {' '}
          <a
            className="settings__link"
            href="https://platform.deepseek.com/api_keys"
            target="_blank"
            rel="noreferrer noopener"
          >
            DeepSeek 控制台
          </a>
          {' '}
          注册一个（充值 1 元就够用很久），把生成的那串 Key 粘到上面。
        </span>

        <details className="settings__advanced">
          <summary>高级：换服务商 / 换模型</summary>
          <label className="field">
            <span className="field__label">API Base URL</span>
            <input
              className="field__input"
              type="text"
              value={baseUrl}
              spellCheck={false}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <span className="field__hint">填到 /v1 为止，例如 https://api.deepseek.com/v1</span>
          </label>

          <label className="field">
            <span className="field__label">Model</span>
            <input
              className="field__input"
              type="text"
              value={model}
              spellCheck={false}
              onChange={(event) => setModel(event.target.value)}
            />
            <span className="field__hint">例如 deepseek-chat、gpt-5-mini、openai/gpt-5-mini</span>
          </label>

          <label className="field">
            <span className="field__label">Provider</span>
            <select className="field__input" value={providerKind} onChange={handleProviderChange}>
              {PROVIDER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {PROVIDER_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>
        </details>
      </fieldset>

      <fieldset className="settings__group">
        <legend className="settings__legend">语言</legend>
        {/*
          Both pickers list the whole registry. The only pair that cannot exist is a language on
          both sides, so that single option is greyed out with the reason next to it - hiding it
          instead would make a language look unsupported, and would hide the way back to a pair
          the user has already used.
        */}
        <label className="field">
          <span className="field__label">我的母语</span>
          <select
            className="field__input"
            value={settings.nativeLanguage}
            disabled={saving}
            onChange={(event) => saveLanguage(event.target.value, 'native')}
          >
            {SUPPORTED_LANGUAGES.map((entry) => {
              const taken = entry.code === settings.learningLanguage
              return (
                <option key={entry.code} value={entry.code} disabled={taken}>
                  {languageOptionLabel(entry) + (taken ? '（正在学的语言）' : '')}
                </option>
              )
            })}
          </select>
          <span className="field__hint">释义和讲解都用这个语言写。</span>
        </label>
        <div className="field__row">
          <button
            type="button"
            className="button"
            disabled={saving}
            onClick={handleSwap}
          >
            ⇄ 互换语言
          </button>
        </div>
        <label className="field">
          <span className="field__label">正在学的语言</span>
          <select
            className="field__input"
            value={settings.learningLanguage}
            disabled={saving}
            onChange={(event) => saveLanguage(event.target.value, 'learning')}
          >
            {SUPPORTED_LANGUAGES.map((entry) => {
              const taken = entry.code === settings.nativeLanguage
              return (
                <option key={entry.code} value={entry.code} disabled={taken}>
                  {languageOptionLabel(entry) + (taken ? '（你的母语）' : '')}
                </option>
              )
            })}
          </select>
          <span className="field__hint">生成和阅读都用这个语言；两个方向都会跟着变。</span>
        </label>
        <span className="field__hint">
          一边和另一边不能是同一个语言。要把对方正在用的语言换过来，点上面的「互换语言」；
          想改成别的语言，两个下拉框里都能选。
        </span>
      </fieldset>

      <fieldset className="settings__group">
        <legend className="settings__legend">浏览器连接</legend>
        {/**
          One switch, off until the user says otherwise, exactly like the recent list - and off
          really means off here: no port is opened at all, so nothing outside this app can reach
          Learn. Switching it on mints the pairing token, which is the thing the extension has to
          be told before it can send anything.
        */}
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.browserBridgePolicy === 'on'}
            disabled={saving}
            onChange={(event) =>
              void onSave({ browserBridgePolicy: event.target.checked ? 'on' : 'off' })
            }
          />
          <span>允许浏览器扩展把句子交给 Learn</span>
        </label>
        <span className="field__hint">
          打开后本机只监听 127.0.0.1（不会被局域网或外网访问）。你在网页上选中一句、点扩展里的
          「学习这句」，桌面就会把它学下来；关掉之后这条连接不打开，扩展也连不上。
        </span>
        <p className="note">状态：{bridgeStateLabel(bridge)}</p>

        {settings.browserBridgePolicy === 'on' ? (
          <>
            <label className="field">
              <span className="field__label">连接口令</span>
              <input
                className="field__input"
                type="text"
                readOnly
                spellCheck={false}
                value={bridge.status?.token ?? ''}
                onFocus={(event) => event.target.select()}
              />
              <span className="field__hint">
                点下面的「复制口令」，再点浏览器工具栏上的扩展图标，把口令粘进弹窗里的「连接口令」框、点「连接」。它只存在本机，别发给别人。
              </span>
            </label>
            <div className="field__row">
              <button
                type="button"
                className="button"
                disabled={bridge.status === null || (bridge.status.token.length === 0)}
                onClick={() => {
                  const token = bridge.status?.token ?? ''
                  if (token.length === 0) return
                  void assistantApi()
                    .copyText(token)
                    .then((ok) => {
                      if (ok) setTokenCopied(true)
                    })
                    .catch(() => undefined)
                }}
              >
                {tokenCopied ? '已复制' : '复制口令'}
              </button>
              <button type="button" className="button" onClick={() => void bridge.resetToken()}>
                重新生成口令
              </button>
            </div>
            <span className="field__hint">
              重新生成会换一串新口令，已经连上的扩展需要重新粘贴一次；已经学到的句子不受影响。
            </span>
            {/* 浏览器不允许多的软件替你装扩展，所以这一段只能"把东西递到手上"：一个按钮把
                扩展所在的文件夹打开，另一个把要在地址栏输入的地址复制好，用户只剩照着点。 */}
            <div className="field__row">
              <button type="button" className="button" onClick={() => void revealExtension()}>
                打开扩展文件夹
              </button>
              <button
                type="button"
                className="button"
                onClick={() => void assistantApi().copyText('chrome://extensions')}
              >
                复制 chrome://extensions
              </button>
            </div>
            <span className="field__hint">
              {extensionNote ??
                '扩展（OmniTranslate 万译）在这个软件安装目录的 extension 文件夹里；点左边那个按钮就能打开它。'}
            </span>
            <ol className="settings__steps">
              <li>浏览器地址栏粘贴 chrome://extensions，右上角打开「开发者模式」。</li>
              <li>点「加载已解压的扩展程序」，选中上面那个文件夹（不是里面的 dist）。</li>
              <li>点浏览器工具栏上的扩展图标，把「连接口令」粘进弹窗里的框、点「连接」。</li>
              {/* 「学习这句」有两个入口，而浮层那个要先按住 Ctrl+Shift 才出来——不写清楚，
                  用户会以为扩展没生效（extension/patch 的补丁文档里也写着同一条）。 */}
              <li>
                在网页上按住 Ctrl+Shift 划词，点浮层底部的「学习这句」；或者直接右键选中的文字 →
                「发送到 AI Language Coach（学习这句）」，结果会显示在页面右下角。
              </li>
            </ol>
          </>
        ) : null}

        {bridge.errorMessage !== null ? (
          <span className="note note--warn">{bridge.errorMessage}</span>
        ) : null}
      </fieldset>

      {/**
        窗口和快捷键是同一个话题的两半：都是"这个软件怎么出现在我面前"。它们共用一个分组，
        不再各占一个标题。
      */}
      <fieldset className="settings__group">
        <legend className="settings__legend">窗口与快捷键</legend>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.floatingBall}
            disabled={saving}
            onChange={(event) => void onSave({ floatingBall: event.target.checked })}
          />
          <span>启用悬浮球（关闭后为普通窗口模式）</span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.launchAtLogin}
            disabled={saving}
            onChange={(event) => void onSave({ launchAtLogin: event.target.checked })}
          />
          <span>开机自启（安装版生效，开发模式不写系统启动项）</span>
        </label>
        <div className="field__row">
          <input
            className="field__input"
            type="text"
            value={accelerator}
            spellCheck={false}
            placeholder="Ctrl+Shift+Space"
            onChange={(event) => setAccelerator(event.target.value)}
          />
          <button
            type="button"
            className="button"
            disabled={shortcut.applying || accelerator.trim().length === 0}
            onClick={() => void shortcut.apply(accelerator)}
          >
            应用
          </button>
        </div>
        <span className="field__hint">
          全局快捷键：在任何应用里呼出 / 收起面板，写法和 Ctrl+Shift+Space、Ctrl+Alt+Q 类似。
        </span>
        {shortcutMessage.length > 0 ? (
          <span className={shortcut.status?.ok === true ? 'field__hint' : 'note note--warn'}>{shortcutMessage}</span>
        ) : null}
      </fieldset>

      <fieldset className="settings__group">
        <legend className="settings__legend">最近翻译</legend>
        {/**
          One switch, and it ships off - keeping a log of what someone typed is their call, not
          a default. Only the user moves it. Turning it off stops recording but does not erase
          what was already kept.
        */}
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.recentPolicy === 'on'}
            disabled={saving}
            onChange={(event) =>
              void onSave({ recentPolicy: event.target.checked ? 'on' : 'off' })
            }
          />
          <span>在本机保留最近翻译</span>
        </label>
        <span className="field__hint">
          默认关闭：不打开时，翻译过的内容不会留下任何记录。打开后，最近 50 条会写进
          recent.json（和 config.json 同目录），方便回头找；关掉只是停止记录，已经记下的还在，
          可以在「最近翻译」里清空。点 Learn 学到的内容记在 learned.json，不受这个开关影响。
        </span>
      </fieldset>

      {settings.hasApiKey && !settings.apiKeyEncrypted ? (
        <p className="note note--warn">系统安全存储不可用，API Key 以明文保存在本机配置文件中。</p>
      ) : null}

      <div className="settings__actions">
        <button type="submit" className="button button--primary" disabled={saving}>
          {saving ? '保存中…' : '保存'}
        </button>
        {settings.hasApiKey ? (
          <button type="button" className="button" onClick={() => void onSave({ apiKey: '' })} disabled={saving}>
            清除已保存的 Key
          </button>
        ) : null}
      </div>
    </form>
  )
}
