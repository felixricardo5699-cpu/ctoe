import { describe, expect, it } from 'vitest'
import type { TranslationRequest } from '@shared/types'
import { parseLearningAnalysis, parseUnderstanding } from '@shared/learning/parse'
import { MOCK_OUTPUT, MOCK_UNDERSTANDING, MockProvider } from './MockProvider'
import { ProviderError } from './errors'

function request(text: string, task: TranslationRequest['task'] = 'express'): TranslationRequest {
  return { task, text, tone: 'natural', context: '', sourceLanguage: 'zh', targetLanguage: 'en' }
}

describe('MockProvider', () => {
  it('streams the canned English and resolves with the whole text', async () => {
    const deltas: string[] = []
    const text = await new MockProvider(0).translate(request('你好'), { onDelta: (chunk) => deltas.push(chunk) })
    expect(text).toBe(MOCK_OUTPUT)
    expect(deltas.join('')).toBe(MOCK_OUTPUT)
    expect(deltas.length).toBeGreaterThan(1)
  })

  it('rejects blank input instead of inventing English', async () => {
    await expect(new MockProvider(0).translate(request('   \n '))).rejects.toBeInstanceOf(ProviderError)
    await expect(new MockProvider(0).translate(request('   '))).rejects.toMatchObject({ code: 'missing-input' })
  })

  it('answers a Learn request with something the parser can read', async () => {
    const text = await new MockProvider(0).translate(request('你好', 'analyze'))

    const analysis = parseLearningAnalysis(text)
    expect(analysis).not.toBeNull()
    expect(analysis?.items.length).toBeGreaterThan(0)
  })

  it('answers an Understand request with a meaning and points the parser can read', async () => {
    const text = await new MockProvider(0).translate(
      request('I was going to join you, but something came up.', 'understand')
    )

    expect(text).toBe(MOCK_UNDERSTANDING)
    const understanding = parseUnderstanding(text)
    expect(understanding?.meaning).toBe('我本来打算加入你们，但临时有点事情。')
    // Both halves come out of the one answer, which is what keeps Understand to one request.
    expect(understanding?.items.map((entry) => entry.expression)).toEqual([
      'something came up',
      'I was going to'
    ])
  })

  it('stops as soon as the request is cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      new MockProvider(0).translate(request('你好'), { signal: controller.signal })
    ).rejects.toMatchObject({ code: 'cancelled' })
  })
})
