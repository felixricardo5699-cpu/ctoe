import type { ProviderKind, ProviderSettings, TranslationRequest } from '@shared/types'
import { MockProvider } from './MockProvider'
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider'
import { ProviderError } from './errors'
import type { AIProvider, TranslateOptions } from './types'

export interface ProviderContext {
  kind: ProviderKind
  /** null when no API key has been stored yet. */
  settings: ProviderSettings | null
}

export function createProvider(context: ProviderContext): AIProvider {
  if (context.kind === 'mock') return new MockProvider()
  const settings = context.settings
  if (settings === null || settings.apiKey.trim().length === 0) return new MissingKeyProvider()
  return new OpenAICompatibleProvider(settings)
}

/** Fails fast with a friendly code instead of sending an unauthenticated request. */
class MissingKeyProvider implements AIProvider {
  readonly id = 'openai-compatible'

  // Same signature as the real provider so the UI cannot tell the difference.
  async translate(_request: TranslationRequest, _options: TranslateOptions = {}): Promise<string> {
    throw new ProviderError('missing-api-key', 'no api key configured')
  }
}
