import type { AssistantApi } from '@shared/types/api'

declare global {
  interface Window {
    /** Injected by the preload script; undefined if the bridge failed to load. */
    api?: AssistantApi
  }
}

export {}
