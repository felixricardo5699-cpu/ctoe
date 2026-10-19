import {
  ANALYSIS_TEMPERATURE,
  REQUEST_TEMPERATURE,
  REQUEST_TIMEOUT_MS
} from '@shared/config/defaults'
import { buildPrompt } from '@shared/prompts/translation'
import type { ProviderSettings, TranslationRequest } from '@shared/types'
import { ProviderError, mapHttpStatus, redactKey, summarizeDetail } from './errors'
import { SseParser, extractDeltaText, extractMessageText, extractStreamError, parseJsonOrNull } from './sse'
import type { AIProvider, TranslateOptions } from './types'

/**
 * Works with every OpenAI-compatible \/chat\/completions endpoint:
 * OpenAI, DeepSeek, OpenRouter, Groq, LM Studio, Ollama, ...
 * Only the endpoint, key and model name come from settings.
 */
export class OpenAICompatibleProvider implements AIProvider {
  readonly id = 'openai-compatible'

  constructor(private readonly settings: ProviderSettings) {}

  async translate(request: TranslationRequest, options: TranslateOptions = {}): Promise<string> {
    const prompt = buildPrompt(request)
    const request$ = createRequestSignal(options.signal)

    let response: Response
    try {
      response = await fetch(buildChatCompletionsUrl(this.settings.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: 'Bearer ' + this.settings.apiKey
        },
        body: JSON.stringify({
          model: this.settings.model,
          messages: [
            { role: 'system', content: prompt.system },
            { role: 'user', content: prompt.user }
          ],
          // A rewrite wants a human voice; the structured answers (Learn, Understand) are
          // teaching text and want less randomness.
          temperature: request.task === 'express' ? REQUEST_TEMPERATURE : ANALYSIS_TEMPERATURE,
          stream: true
        }),
        signal: request$.signal
      })
    } catch (error) {
      throw toTransportError(error, options.signal, request$.timedOut(), this.settings.apiKey)
    } finally {
      request$.dispose()
    }

    if (!response.ok) {
      const body = await readTextSafely(response)
      throw new ProviderError(
        mapHttpStatus(response.status, body),
        summarizeDetail(redactKey('HTTP ' + response.status + ' ' + body, this.settings.apiKey))
      )
    }

    // Some gateways ignore "stream": true and answer with one JSON document.
    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const payload = await readJsonSafely(response)
      const text = extractMessageText(payload)
      if (text.trim().length === 0) {
        throw new ProviderError('empty-response', 'non-streaming response contained no text')
      }
      options.onDelta?.(text)
      return text
    }

    return await consumeEventStream(response, options, this.settings.apiKey)
  }
}

export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/chat/completions')) return trimmed
  return trimmed + '/chat/completions'
}

interface RequestSignal {
  signal: AbortSignal
  timedOut: () => boolean
  dispose: () => void
}

/**
 * Manual timeout + cancellation wiring instead of AbortSignal.any/timeout so the
 * reason for aborting stays distinguishable (user cancel vs. timeout).
 */
export function createRequestSignal(external?: AbortSignal, timeoutMs: number = REQUEST_TIMEOUT_MS): RequestSignal {
  const controller = new AbortController()
  let timedOut = false
  const forward = (): void => controller.abort(external?.reason)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error('request timeout'))
  }, timeoutMs)

  if (external !== undefined) {
    if (external.aborted) forward()
    else external.addEventListener('abort', forward)
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      external?.removeEventListener('abort', forward)
    }
  }
}

export function toTransportError(
  error: unknown,
  external: AbortSignal | undefined,
  timedOut: boolean,
  apiKey = ''
): ProviderError {
  if (error instanceof ProviderError) return error
  if (timedOut) return new ProviderError('timeout', 'request timed out')
  if (external?.aborted === true) return new ProviderError('cancelled', 'request cancelled by user')
  const message = error instanceof Error ? error.message : String(error)
  return new ProviderError('network', summarizeDetail(redactKey(message, apiKey)))
}

async function consumeEventStream(
  response: Response,
  options: TranslateOptions,
  apiKey: string
): Promise<string> {
  const body = response.body
  if (body === null) throw new ProviderError('empty-response', 'streaming response had no body')

  const reader = body.getReader()
  const decoder = new TextDecoder()
  const parser = new SseParser()
  let text = ''
  let sawStreamMarker = false
  let parsedPayloads = 0
  let finished = false
  let drained = false

  const handlePayload = (data: string): void => {
    if (data === '[DONE]') {
      finished = true
      sawStreamMarker = true
      return
    }
    const payload = parseJsonOrNull(data)
    if (payload !== null) {
      parsedPayloads += 1
      sawStreamMarker = true
    }
    const streamError = extractStreamError(payload)
    if (streamError !== null) {
      throw new ProviderError('server-error', summarizeDetail(redactKey(streamError, apiKey)))
    }
    const delta = extractDeltaText(payload)
    if (delta.length > 0) {
      text += delta
      options.onDelta?.(delta)
    }
  }

  try {
    while (!finished) {
      const { done, value } = await reader.read()
      if (done) {
        drained = true
        break
      }
      for (const event of parser.push(decoder.decode(value, { stream: true }))) {
        handlePayload(event.data)
        if (finished) break
      }
    }
    if (!finished) {
      for (const event of parser.push(decoder.decode())) handlePayload(event.data)
      for (const event of parser.flush()) handlePayload(event.data)
    }
  } finally {
    // Stop the HTTP stream early once the model is done sending.
    if (!drained) {
      try {
        await reader.cancel()
      } catch {
        // The connection is already gone; nothing left to clean up.
      }
    }
  }

  if (text.trim().length === 0) {
    // A real stream that carried no text is a different problem for the user than
    // a response that was not an SSE stream at all.
    if (parsedPayloads > 0 || sawStreamMarker) {
      throw new ProviderError('empty-response', 'stream contained no text')
    }
    throw new ProviderError('malformed-response', 'stream contained no SSE payload')
  }
  return text
}

async function readTextSafely(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

async function readJsonSafely(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown
  } catch {
    return null
  }
}
