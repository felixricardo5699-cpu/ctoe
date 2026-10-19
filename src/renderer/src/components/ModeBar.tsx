import type { ReactElement } from 'react'
import { PANEL_MODE_LABELS, type PanelMode } from '@shared/types'

const MODES: readonly PanelMode[] = ['express', 'understand']

interface ModeBarProps {
  mode: PanelMode
  /** Endonyms of the profile pair. Both roles are on screen, so the direction is never in doubt. */
  nativeName: string
  learningName: string
  /** Locked while a request runs, so the answer on screen always belongs to the visible mode. */
  disabled?: boolean
  onChange: (mode: PanelMode) => void
}

/**
 * Who the user is, and which way this run goes: the profile pair, then the two modes.
 *
 * The direction is never something the user picks per run - it follows from the profile plus
 * the mode (Say it = native -> learning, Understand = learning -> native) - so this row states
 * the profile instead of offering direction controls. The tabs only ever choose a mode, and
 * the pair itself is edited in Settings.
 */
export function ModeBar({
  mode,
  nativeName,
  learningName,
  disabled = false,
  onChange
}: ModeBarProps): ReactElement {
  // The tabs are labelled with the language each one works on, never with an arrow.
  const hints: Record<PanelMode, string> = {
    express: '用' + nativeName + '写下你的意思，得到自然的' + learningName,
    understand: '把读到的' + learningName + '粘贴进来，用' + nativeName + '解释'
  }
  return (
    <div className="modebar">
      <p className="modebar__profile">
        <span className="modebar__role">
          Native: <span dir="auto">{nativeName}</span>
        </span>
        <span className="modebar__sep" aria-hidden="true">
          ·
        </span>
        <span className="modebar__role">
          Learning: <span dir="auto">{learningName}</span>
        </span>
      </p>
      <div className="modebar__switch" role="group" aria-label="模式">
        {MODES.map((entry) => (
          <button
            key={entry}
            type="button"
            title={hints[entry]}
            aria-pressed={mode === entry}
            disabled={disabled}
            className={mode === entry ? 'modebar__tab modebar__tab--active' : 'modebar__tab'}
            onClick={() => onChange(entry)}
          >
            {PANEL_MODE_LABELS[entry]}
          </button>
        ))}
      </div>
    </div>
  )
}
