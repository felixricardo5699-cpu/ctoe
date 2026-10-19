import { afterEach, describe, expect, it, vi } from 'vitest'
import { REQUEST_TIMEOUT_MS } from '@shared/config/defaults'
import type { TranslationErrorCode, TranslationRequest } from '@shared/types'
import { OpenAICompatibleProvider, buildChatCompletionsUrl } from './OpenAICompatibleProvider'
import { ProviderError } from './errors'

const SETTINGS = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  apiKey: 'sk-secret-value'
}

interface FetchInit {
  method: string
  headers: Record<string, string>
  body: string
  signal?: AbortSignal
}

function request(): TranslationRequest {
  return { task: 'express', text: '你好', tone: 'natural', context: '', sourceLanguage: 'zh', targetLanguage: 'en' }
}

function streamResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
}

function delta(text: string): string {
  return 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n'
}

function stubFetch(implementation: (url: string, init: FetchInit) => Promise<Response>) {
  const mock = vi.fn(implementation)
  vi.stubGlobal('fetch', mock)
  return mock
}

async function expectProviderError(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ProviderError) return error
    throw error
  }
  throw new Error('expected the provider to fail')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('buildChatCompletionsUrl', () => {
  it('accepts the usual base-url shapes', () => {
    expect(buildChatCompletionsUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(buildChatCompletionsUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(buildChatCompletionsUrl('  https://api.example.com/v1  ')).toBe('https://api.example.com/v1/chat/completions')
    expect(buildChatCompletionsUrl('https://api.example.com/v1/chat/completions')).toBe(
      'https://api.example.com/v1/chat/completions'
    )
  })
})

describe('OpenAICompatibleProvider', () => {
  it('streams deltas and sends a short, correct request', async () => {
    const fetchMock = stubFetch(async () =>
      streamResponse([delta('I think '), delta('that is a bit too absolute.'), 'data: [DONE]\n\n'])
    )
    const deltas: string[] = []

    const text = await new OpenAICompatibleProvider(SETTINGS).translate(request(), {
      onDelta: (chunk) => deltas.push(chunk)
    })

    expect(text).toBe('I think that is a bit too absolute.')
    expect(deltas).toEqual(['I think ', 'that is a bit too absolute.'])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, FetchInit]
    expect(url).toBe('https://api.example.com/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(init.headers.authorization).toBe('Bearer ' + SETTINGS.apiKey)
    const body = JSON.parse(init.body) as {
      model: string
      stream: boolean
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe('test-model')
    expect(body.stream).toBe(true)
    expect(body.messages[0].role).toBe('system')
    expect(body.messages[1].content).toContain('你好')
  })

  it('sends the configured pair, not the pair the app shipped with', async () => {
    const fetchMock = stubFetch(async () => streamResponse([delta('Hola'), 'data: [DONE]\n\n']))

    await new OpenAICompatibleProvider(SETTINGS).translate(
      { ...request(), text: 'Bonjour tout le monde', sourceLanguage: 'fr', targetLanguage: 'es' }
    )

    const [, init] = fetchMock.mock.calls[0] as [string, FetchInit]
    const body = JSON.parse(init.body) as { messages: Array<{ role: string; content: string }> }
    const system = body.messages[0]?.content ?? ''
    expect(system).toContain('French')
    expect(system).toContain('Spanish')
    expect(system).not.toContain('Chinese')
    expect(body.messages[1]?.content).toContain('Bonjour tout le monde')
  })

  it('accepts a gateway that ignores stream:true and answers with json', async () => {
    stubFetch(async () => jsonResponse({ choices: [{ message: { content: 'Hello there.' } }] }))
    const deltas: string[] = []
    const text = await new OpenAICompatibleProvider(SETTINGS).translate(request(), {
      onDelta: (chunk) => deltas.push(chunk)
    })
    expect(text).toBe('Hello there.')
    expect(deltas).toEqual(['Hello there.'])
  })

  const httpCases: Array<{ status: number; body: string; code: TranslationErrorCode }> = [
    { status: 401, body: '{"error":"bad key"}', code: 'unauthorized' },
    { status: 403, body: '{"error":"forbidden"}', code: 'unauthorized' },
    { status: 404, body: '{}', code: 'model-not-found' },
    { status: 400, body: '{"error":{"message":"Model Not Exist"}}', code: 'model-not-found' },
    { status: 429, body: '{"error":"rate limited"}', code: 'rate-limited' },
    { status: 500, body: 'oops', code: 'server-error' },
    { status: 418, body: 'teapot', code: 'unknown' }
  ]

  for (const testCase of httpCases) {
    it('maps HTTP ' + testCase.status + ' to ' + testCase.code, async () => {
      stubFetch(async () => new Response(testCase.body, { status: testCase.status }))
      const error = await expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))
      expect(error.code).toBe(testCase.code)
      // Developer detail must never carry the API key.
      expect(error.detail).not.toContain(SETTINGS.apiKey)
    })
  }

  it('times out instead of hanging forever', async () => {
    vi.useFakeTimers()
    stubFetch(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )

    const assertion = expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 1)

    expect((await assertion).code).toBe('timeout')
  })

  it('reports a user cancellation separately from a timeout', async () => {
    stubFetch(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const controller = new AbortController()
    const assertion = expectProviderError(
      new OpenAICompatibleProvider(SETTINGS).translate(request(), { signal: controller.signal })
    )
    controller.abort()
    expect((await assertion).code).toBe('cancelled')
  })

  it('calls a stream without text an empty response', async () => {
    stubFetch(async () => streamResponse(['data: [DONE]\n\n']))
    expect((await expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))).code).toBe(
      'empty-response'
    )
  })

  it('reports a non-SSE body as malformed', async () => {
    stubFetch(async () => streamResponse(['this is not an event stream']))
    expect((await expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))).code).toBe(
      'malformed-response'
    )
  })

  it('reports a response without a body', async () => {
    stubFetch(async () => new Response(null, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
    expect((await expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))).code).toBe(
      'empty-response'
    )
  })

  it('surfaces errors that arrive inside the stream', async () => {
    stubFetch(async () => streamResponse(['data: {"error":{"message":"model overloaded"}}\n\n']))
    const error = await expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))
    expect(error.code).toBe('server-error')
    expect(error.detail).toBe('model overloaded')
  })

  it('skips junk events but still returns the text that follows', async () => {
    stubFetch(async () => streamResponse(['data: not-json\n\n', delta('Hi'), 'data: [DONE]\n\n']))
    expect(await new OpenAICompatibleProvider(SETTINGS).translate(request())).toBe('Hi')
  })

  it('turns a network failure into the network code', async () => {
    stubFetch(async () => {
      throw new TypeError('fetch failed')
    })
    expect((await expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))).code).toBe('network')
  })
})

describe('api key safety', () => {
  it('never leaves the key in the error detail, even when the provider echoes it back', async () => {
    stubFetch(async () =>
      jsonResponse(
        { error: { message: 'Authentication Fails, your api key ' + SETTINGS.apiKey + ' is invalid' } },
        401
      )
    )

    const error = await expectProviderError(new OpenAICompatibleProvider(SETTINGS).translate(request()))

    expect(error.code).toBe('unauthorized')
    expect(error.detail).not.toContain(SETTINGS.apiKey)
    expect(error.detail).toContain('[redacted]')
  })
})
