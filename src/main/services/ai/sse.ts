/** One parsed Server-Sent-Event block. */
export interface SseEvent {
  event: string
  data: string
}

/**
 * Incremental SSE parser: chat APIs split events across arbitrary chunk
 * boundaries, so parsing has to be stateful and streaming-only.
 */
export class SseParser {
  private buffer = ''

  push(chunk: string): SseEvent[] {
    // Normalize line endings once so block detection only has to look for one marker.
    this.buffer += chunk.split('\r\n').join('\n')
    const events: SseEvent[] = []
    let separator = this.buffer.indexOf('\n\n')
    while (separator !== -1) {
      const block = this.buffer.slice(0, separator)
      this.buffer = this.buffer.slice(separator + 2)
      const parsed = parseEventBlock(block)
      if (parsed !== null) events.push(parsed)
      separator = this.buffer.indexOf('\n\n')
    }
    return events
  }

  /** Anything left in the buffer once the stream ended (tolerates missing trailing blank line). */
  flush(): SseEvent[] {
    const rest = this.buffer
    this.buffer = ''
    const parsed = parseEventBlock(rest)
    return parsed === null ? [] : [parsed]
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

export function parseJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readContentString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function firstChoice(payload: unknown): Record<string, unknown> | null {
  if (!isRecord(payload)) return null
  const choices = payload.choices
  if (!Array.isArray(choices) || choices.length === 0) return null
  const first = choices[0]
  return isRecord(first) ? first : null
}

/** Streaming shape: choices[0].delta.content (OpenAI, DeepSeek, OpenRouter, ...). */
export function extractDeltaText(payload: unknown): string {
  const choice = firstChoice(payload)
  if (choice === null) return ''
  const delta = choice.delta
  if (isRecord(delta)) return readContentString(delta.content)
  return readContentString(choice.text)
}

/** Some gateways report failures inside a 200 stream: { error: { message } }. */
export function extractStreamError(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const error = payload.error
  if (typeof error === 'string') return error
  if (isRecord(error)) return readContentString(error.message)
  return null
}

/** Non-streaming shape: choices[0].message.content. */
export function extractMessageText(payload: unknown): string {
  const choice = firstChoice(payload)
  if (choice === null) return ''
  const message = choice.message
  if (isRecord(message)) return readContentString(message.content)
  return ''
}
