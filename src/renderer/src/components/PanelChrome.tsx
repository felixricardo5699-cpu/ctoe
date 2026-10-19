import type { ReactElement } from 'react'
import { usePanelActions } from '../hooks/usePanelActions'

interface PanelChromeProps {
  /** Hiding to the tray is always available; collapsing only makes sense in ball mode. */
  floatingBall: boolean
  shortcut?: string
}

/** The two window buttons in the panel header: reduce to the ball, or hide entirely. */
export function PanelChrome({ floatingBall, shortcut }: PanelChromeProps): ReactElement {
  const { collapse, hide } = usePanelActions()
  const collapseHint =
    shortcut !== undefined && shortcut.length > 0
      ? '收起为悬浮球（' + shortcut + '）'
      : '收起为悬浮球'

  return (
    <>
      {floatingBall ? (
        <button
          type="button"
          className="chrome"
          aria-label="收起为悬浮球"
          title={collapseHint}
          onClick={collapse}
        >
          −
        </button>
      ) : null}
      <button
        type="button"
        className="chrome"
        aria-label="隐藏到托盘"
        title="隐藏到托盘（托盘图标或快捷键可再次打开）"
        onClick={hide}
      >
        ×
      </button>
    </>
  )
}
