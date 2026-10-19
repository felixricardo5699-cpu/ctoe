import type { ReactElement } from 'react'
import type { PanelMode } from '@shared/types'
import type { TranslationStatus } from '../hooks/useTranslation'

interface StatusBarProps {
  status: TranslationStatus
  errorMessage: string | null
  direction: PanelMode
}

/** What is happening right now, in the same words the buttons use. */
const BUSY_LABELS: Record<TranslationStatus, string> = {
  idle: '',
  generating: 'Generating...',
  understanding: 'Understanding...',
  analyzing: 'Analyzing...',
  ready: '',
  error: ''
}

/** The keyboard hints follow the mode: the same keys, named after what they do there. */
const HINTS: Record<PanelMode, string> = {
  express: 'Alt+Enter 生成 · Alt+R 重新生成 · Alt+Q 复制',
  understand: 'Alt+Enter 解释 · Alt+R 重新解释 · Alt+Q 复制'
}

export function StatusBar({ status, errorMessage, direction }: StatusBarProps): ReactElement {
  if (errorMessage !== null) {
    return <p className="status status--error" role="alert">{errorMessage}</p>
  }
  const busy = BUSY_LABELS[status]
  if (busy.length > 0) {
    return <p className="status status--busy" role="status">{busy}</p>
  }
  return <p className="status status--hint">{HINTS[direction]}</p>
}
