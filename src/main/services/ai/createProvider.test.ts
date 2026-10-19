import { describe, expect, it } from 'vitest'
import type { TranslationRequest } from '@shared/types'
import { createProvider } from './createProvider'

function request(text: string): TranslationRequest {
  return { task: 'express', text, tone: 'natural', context: '', sourceLanguage: 'zh', targetLanguage: 'en' }
}

describe('createProvider', () => {
  it('honours an explicit choice of the mock provider', () => {
    expect(createProvider({ kind: 'mock', settings: null }).id).toBe('mock')
  })

  it('fails fast when no API key is stored', async () => {
    const provider = createProvider({ kind: 'openai-compatible', settings: null })
    await expect(provider.translate(request('你好'))).rejects.toMatchObject({ code: 'missing-api-key' })
  })

  it('builds the OpenAI-compatible provider once a key exists', () => {
    const provider = createProvider({
      kind: 'openai-compatible',
      settings: { baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k' }
    })
    expect(provider.id).toBe('openai-compatible')
  })
})
