import type { ReactElement, ReactNode } from 'react'

interface InputActionsProps {
  /** Short-lived hint such as "已粘贴"; null hides the slot. */
  hint: string | null
  canCopy: boolean
  onPaste: () => void
  onCopy: () => void
  /** Drawn before the clipboard buttons, for a tool that belongs to the text itself. */
  leading?: ReactNode
}

/**
 * Clipboard helpers for the box the user brings text into: import whatever was copied from
 * another app, or copy what is in there back out. The answer box keeps its own 复制 button
 * in the toolbar.
 */
export function InputActions(props: InputActionsProps): ReactElement {
  return (
    <div className="panel__actions">
      {props.leading}
      {props.hint === null ? null : <span className="panel__hint">{props.hint}</span>}
      <button
        type="button"
        className="button button--mini"
        aria-label="从剪贴板粘贴"
        onClick={props.onPaste}
      >
        粘贴
      </button>
      <button
        type="button"
        className="button button--mini"
        aria-label="复制输入内容"
        disabled={!props.canCopy}
        onClick={props.onCopy}
      >
        复制
      </button>
    </div>
  )
}
