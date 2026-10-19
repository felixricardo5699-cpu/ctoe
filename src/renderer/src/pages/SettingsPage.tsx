import { useEffect, useState, type ReactElement } from 'react'
import type { PublicSettings, SettingsPatch } from '@shared/types'
import { PanelChrome } from '../components/PanelChrome'
import { SettingsForm } from '../components/SettingsForm'
import { useBrowserBridge } from '../hooks/useBrowserBridge'
import { useGlobalShortcut } from '../hooks/useGlobalShortcut'
import { assistantApi } from '../services/assistantApi'

/** The folder a file lives in, without importing node:path into the renderer. */
function folderOf(file: string): string {
  return file.replace(/[\\/][^\\/]+$/, '')
}

interface SettingsPageProps {
  settings: PublicSettings | null
  saving: boolean
  errorMessage: string | null
  onSave: (patch: SettingsPatch) => Promise<void>
  onBack: () => void
}

export function SettingsPage({ settings, saving, errorMessage, onSave, onBack }: SettingsPageProps): ReactElement {
  const shortcut = useGlobalShortcut()
  // The bridge's own state, not a setting: it is read from the main process so the page shows
  // which port is really held rather than what the settings file was asked for.
  const bridge = useBrowserBridge()
  // Where the app keeps its files. The path is read on mount so the answer is on screen before
  // anyone has to ask for it - "where is my data" is a question people arrive with.
  const [dataFolder, setDataFolder] = useState<string | null>(null)
  const [dataNote, setDataNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void assistantApi()
      .getAppInfo()
      .then((info) => {
        if (!cancelled) setDataFolder(folderOf(info.configPath))
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  const revealDataFolder = async (): Promise<void> => {
    try {
      const result = await assistantApi().openDataFolder()
      if (result.folder !== null) setDataFolder(result.folder)
      setDataNote(result.ok ? null : result.message.length > 0 ? result.message : '打不开数据文件夹。')
    } catch {
      setDataNote('打不开数据文件夹。')
    }
  }

  return (
    <div className="settings">
      <header className="settings__header">
        <h1 className="settings__title">设置</h1>
        <div className="settings__header-actions">
          <button type="button" className="button button--ghost" onClick={onBack}>
            返回
          </button>
          <PanelChrome floatingBall={settings?.floatingBall ?? true} shortcut={settings?.globalShortcut} />
        </div>
      </header>

      {/* Everything below the header scrolls on its own; the header itself never moves. */}
      <div className="settings__body">
        {settings === null ? (
          <p className="note">正在读取设置…</p>
        ) : (
          <SettingsForm
            settings={settings}
            saving={saving}
            onSave={onSave}
            shortcut={shortcut}
            bridge={bridge}
          />
        )}

        {errorMessage !== null ? <p className="status status--error">{errorMessage}</p> : null}

        <details className="settings__advanced">
          <summary>隐私说明：数据都存在哪里</summary>
          <p className="note">
            隐私：只有你点击 “Generate / Explain / 重新生成” 时，输入的内容才会发送给你配置的 AI 服务商；点击 “Learn” 时会把这次的原文和生成结果一起发过去（不然没法讲解）。Learn 只在点击时发生，不会自动分析，也不会保存。剪贴板只在你点击“粘贴”时读取，不会读取网页内容或浏览记录。
          </p>
          <p className="note">
            生成的结果默认不保存。只有你点工具栏的 “Learn” 时，这句话才会写进本机的
            learned.json（和 config.json 放在同一个应用数据目录，权限 0600）——记下的是你的原文、
            生成的自然表达、这一对语言、Learn 找到的表达/句式/词汇，以及时间。没有点 Learn 的内容不会留下任何痕迹。
            记录可以在 “My Learning” 里逐条删除或清空，删除是真的从文件里移除。
          </p>
          <p className="note">
            最近翻译默认关闭，开关在「最近翻译」一节。打开后，你 Generate / Explain 过的每一句（原文、
            结果、这一对语言和时间）会写进本机的 recent.json——和 config.json 同目录，最多 50 条，
            更早的会被挤掉，可以在「最近翻译」里一键清空。它和学习记录是两件事：清空这个列表不会动
            learned.json，关掉开关也不会删掉已经记下的。
          </p>
          <p className="note">配置、My Learning 和最近翻译都只存在本机，不上传、不联网、没有账号。</p>
          {/* 路径对多数人只是噪音，但"我的数据在哪"这个问题必须有一个不靠记忆的答案，
              所以它和打开按钮放在同一个折叠块里，点一下就是资源管理器。 */}
          <div className="field__row">
            <button type="button" className="button" onClick={() => void revealDataFolder()}>
              打开数据文件夹
            </button>
          </div>
          <span className="field__hint">
            {dataFolder === null ? '配置、学习记录与最近翻译都放在这个文件夹里。' : dataFolder}
          </span>
          <p className="note">
            My Learning 页的「导出为 Word」会把学习记录按语言对写成 .docx（先逐句、再按表达 / 句式 /
            词汇 / 语法整理索引），默认存到「文档\ctoe 学习记录」，也可以每次自己选文件夹。
          </p>
          {dataNote !== null ? <p className="note note--warn">{dataNote}</p> : null}
        </details>
      </div>
    </div>
  )
}
