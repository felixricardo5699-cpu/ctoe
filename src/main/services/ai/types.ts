import type { TranslationRequest } from '@shared/types'

export interface TranslateOptions {
  /** Aborted when the user cancels or the app shuts the request down. */
  signal?: AbortSignal
  /** Called for every partial chunk so the UI can render text while it arrives. */
  onDelta?: (chunk: string) => void
}

/**
 * The one abstraction the app is built around: swapping DeepSeek for OpenAI,
 * OpenRouter, a local model or a mock must never touch UI or IPC code.
 */
export interface AIProvider {
  readonly id: string
  /** Streams through options.onDelta and resolves with the final text. */
  translate(request: TranslationRequest, options?: TranslateOptions): Promise<string>
}
