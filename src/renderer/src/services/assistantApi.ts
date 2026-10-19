import type { AssistantApi } from '@shared/types/api'

/**
 * The only way the UI reaches the main process. Keeping it behind one function
 * means there is exactly one place that knows about the preload bridge.
 */
export function assistantApi(): AssistantApi {
  const api = window.api
  if (api === undefined) {
    throw new Error('preload bridge unavailable')
  }
  return api
}

/**
 * Fire-and-forget call for UI chrome (window buttons, drag reporting): the result is
 * never rendered, so a missing bridge or a rejected call must not surface as an error.
 */
export function fireAndForget(run: (api: AssistantApi) => Promise<unknown>): void {
  try {
    void run(assistantApi()).catch(() => undefined)
  } catch {
    // No preload bridge: nothing to talk to.
  }
}
