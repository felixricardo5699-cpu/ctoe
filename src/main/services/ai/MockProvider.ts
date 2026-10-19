import type { TaskKind, TranslationRequest } from '@shared/types'
import { isBlank } from '@shared/utils/text'
import { ProviderError } from './errors'
import type { AIProvider, TranslateOptions } from './types'

/** Canned "natural English" so the whole flow can be exercised without a network call. */
export const MOCK_OUTPUT = [
  'I think that is a bit too absolute.',
  'It may not be as simple as it looks, and we might need to look at it from another angle.'
].join(' ')

/**
 * Canned Learn answer in the same JSON shape the real model is asked for, so the Learn
 * path (prompt -> provider -> parse -> UI) can be exercised offline.
 */
export const MOCK_ANALYSIS = JSON.stringify(
  {
    items: [
      {
        kind: 'expression',
        expression: 'pretty interesting',
        meaning: '挺有意思',
        why: '比 very interesting 更口语，聊天里更像母语者',
        example: 'I think the idea is pretty interesting.',
        exampleTranslation: '我觉得这个想法挺有意思。'
      },
      {
        kind: 'pattern',
        expression: 'I am not sure if it will work',
        meaning: '我不知道能不能成',
        why: '不确定时的万能说法，比 I do not know 更柔和',
        example: 'I am not sure if it will work, but let us try.',
        exampleTranslation: '我不确定这样能不能成，但我们试试看。'
      }
    ]
  },
  null,
  2
)

/**
 * Canned Understand answer in the same JSON shape the real model is asked for, so the
 * Understand path (prompt -> provider -> parse -> UI) can be exercised offline too.
 */
export const MOCK_UNDERSTANDING = JSON.stringify(
  {
    meaning: '我本来打算加入你们，但临时有点事情。',
    items: [
      {
        kind: 'expression',
        expression: 'something came up',
        meaning: '临时有事',
        why: '口语里常用来解释临时原因',
        example: 'Something came up, so I cannot make it tonight.',
        exampleTranslation: '临时有事，所以今晚我来不了。'
      },
      {
        kind: 'pattern',
        expression: 'I was going to',
        meaning: '我本来打算',
        why: '说一个后来没做成的计划',
        example: 'I was going to call you, but it got late.',
        exampleTranslation: '我本来想给你打电话，但是太晚了。'
      }
    ]
  },
  null,
  2
)

/** One canned answer per task, so the mock can never answer the wrong shape by accident. */
const CANNED_BY_TASK: Record<TaskKind, string> = {
  express: MOCK_OUTPUT,
  analyze: MOCK_ANALYSIS,
  understand: MOCK_UNDERSTANDING
}

export const MOCK_CHUNK_DELAY_MS = 25

export class MockProvider implements AIProvider {
  readonly id = 'mock'

  constructor(private readonly chunkDelayMs: number = MOCK_CHUNK_DELAY_MS) {}

  async translate(request: TranslationRequest, options: TranslateOptions = {}): Promise<string> {
    if (isBlank(request.text)) {
      throw new ProviderError('missing-input', 'mock provider received blank input')
    }
    const canned = CANNED_BY_TASK[request.task]
    // Splitting on "token + trailing whitespace" keeps line breaks intact when rejoined.
    const chunks = canned.match(/\S+\s*/g) ?? [canned]
    let text = ''
    for (const chunk of chunks) {
      if (options.signal?.aborted === true) {
        throw new ProviderError('cancelled', 'mock request aborted')
      }
      text += chunk
      options.onDelta?.(chunk)
      await delay(this.chunkDelayMs)
    }
    return text
  }
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => setTimeout(resolve, ms))
}
