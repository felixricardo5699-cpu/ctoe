import { useMemo } from 'react'
import { fireAndForget } from '../services/assistantApi'

export interface PanelActions {
  /** Panel -> floating ball. The app keeps running. */
  collapse(): void
  /** Hides the window; the tray icon or the global shortcut brings it back. */
  hide(): void
  quit(): void
}

/** The three window buttons a panel header needs, in one place. */
export function usePanelActions(): PanelActions {
  return useMemo(
    () => ({
      collapse: () => fireAndForget((api) => api.collapsePanel()),
      hide: () => fireAndForget((api) => api.hidePanel()),
      quit: () => fireAndForget((api) => api.quitApp())
    }),
    []
  )
}
