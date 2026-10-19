import { useState, type ReactElement } from 'react'
import type { PublicSettings } from '@shared/types'
import { useBrowserBridge } from '../hooks/useBrowserBridge'
import { relativeTimeLabel } from '../utils/relativeTime'

interface StartStepProps {
  done: boolean
  title: string
  detail: string
  action?: { label: string; onClick: () => void }
}

/** 一行一步：左边一个勾，中间一句话，右边一个"这就去做"的按钮。 */
function StartStep({ done, title, detail, action }: StartStepProps): ReactElement {
  return (
    <li className={done ? 'start__step start__step--done' : 'start__step'}>
      <span className="start__mark">{done ? '✓' : '○'}</span>
      <span className="start__text">
        <span className="start__title">{title}</span>
        <span className="start__detail">{detail}</span>
      </span>
      {action === undefined ? null : (
        <button type="button" className="button button--mini" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </li>
  )
}

interface StartCardProps {
  settings: PublicSettings | null
  /** How many sentences My Learning already holds. 0 means nothing has been learned yet. */
  learnedCount: number
  /** Puts the caret in the input box, so the second step costs one click instead of a hunt. */
  onFocusInput: () => void
  onOpenSettings: () => void
}

/**
 * 第一次用的三步。
 *
 * 它读的全是已经存在的东西：hasApiKey（配好没有）、My Learning 的条数（学过没有）、
 * browserBridgePolicy 与 bridge 的 lastRequestAt（浏览器那半通没通）。所以这不是一个新状态，
 * 只是把散在各处的"你做完了吗"收在一处——三件都做完，它自己就消失了，之后再也见不到。
 *
 * 关掉只对这一次有效：装成"永久不再提示"要往配置里加字段，而那是一个新的数据形状，
 * 代价比多点一次 × 大。
 */
export function StartCard({ settings, learnedCount, onFocusInput, onOpenSettings }: StartCardProps): ReactElement | null {
  const [dismissed, setDismissed] = useState(false)
  const bridge = useBrowserBridge()
  const keyReady = settings?.hasApiKey === true
  const studied = learnedCount > 0
  const listening = settings?.browserBridgePolicy === 'on'
  const lastUsed = bridge.status?.lastRequestAt ?? null
  if (dismissed) return null

  const browserDetail = listening
    ? lastUsed === null
      ? '已经打开，等扩展连上：把口令粘到扩展的「浏览器连接」里'
      : '已连上' + (relativeTimeLabel(lastUsed, Date.now()) === '' ? '' : ' · 上次使用：' + relativeTimeLabel(lastUsed, Date.now()))
    : '装好 OmniTranslate 万译扩展，在网页上划词就能学'

  return (
    <section className="start">
      <div className="start__head">
        <span className="start__heading">开始使用</span>
        <button
          type="button"
          className="start__close"
          title="先收起来（下次打开还会出现）"
          onClick={() => setDismissed(true)}
        >
          ×
        </button>
      </div>
      <ul className="start__list">
        <StartStep
          done={keyReady}
          title="配置 AI"
          detail={keyReady ? '已经有 Key，可以生成了' : '一个 API Key：只存在本机，第一次生成必须要有'}
          action={keyReady ? undefined : { label: '去配置', onClick: onOpenSettings }}
        />
        <StartStep
          done={studied}
          title="学第一句话"
          detail={studied ? '已经学过了，去 My Learning 看看' : '输入一句中文 → Generate → 点 Learn'}
          action={studied ? undefined : { label: '去试试', onClick: onFocusInput }}
        />
        <StartStep
          done={listening && lastUsed !== null}
          title="让浏览器也能学"
          detail={browserDetail}
          action={{ label: '去设置', onClick: onOpenSettings }}
        />
      </ul>
    </section>
  )
}