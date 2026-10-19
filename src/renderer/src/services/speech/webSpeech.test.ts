// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebSpeechEngine } from './webSpeech'
import { DEFAULT_SPEECH_RATE, speakKey } from './types'

/** One utterance as the platform sees it. Only the fields the engine sets are modelled. */
interface FakeUtterance {
  text: string
  lang: string
  rate: number
  onend: (() => void) | null
  onerror: (() => void) | null
}

interface FakePlatform {
  spoken: FakeUtterance[]
  cancels: number
  /** What the platform does when asked to speak: normally nothing. */
  refuse: boolean
}

function fakePlatform(overrides: Partial<Pick<FakePlatform, 'refuse'>> = {}): FakePlatform {
  const state: FakePlatform = { spoken: [], cancels: 0, refuse: overrides.refuse ?? false }
  class FakeUtteranceCtor {
    text: string
    lang = ''
    rate = 0
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(text: string) {
      this.text = text
      state.spoken.push(this as unknown as FakeUtterance)
    }
  }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    value: FakeUtteranceCtor,
    configurable: true,
    writable: true
  })
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      speak: (): void => {
        if (state.refuse) throw new Error('no voice for this language')
      },
      cancel: (): void => {
        state.cancels += 1
      }
    },
    configurable: true,
    writable: true
  })
  return state
}

function removePlatform(): void {
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true })
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true })
}

afterEach(() => {
  removePlatform()
  vi.restoreAllMocks()
})

describe('speech engine', () => {
  it('says it cannot read when the platform has no voices', () => {
    removePlatform()
    const engine = createWebSpeechEngine()

    expect(engine.available()).toBe(false)
    expect(engine.speak({ text: 'hello', language: 'en' })).toBe(false)
    expect(engine.current()).toBeNull()
  })

  it('reads the line in the language it belongs to, at normal speed', () => {
    const platform = fakePlatform()
    const engine = createWebSpeechEngine()

    expect(engine.speak({ text: '  Bonjour tout le monde  ', language: 'fr' })).toBe(true)

    expect(platform.spoken).toHaveLength(1)
    // Trimmed, so the voice does not pause at the edge of the selection.
    expect(platform.spoken[0]?.text).toBe('Bonjour tout le monde')
    expect(platform.spoken[0]?.lang).toBe('fr-FR')
    expect(platform.spoken[0]?.rate).toBe(DEFAULT_SPEECH_RATE)
    expect(engine.current()).toBe(speakKey('Bonjour tout le monde', 'fr'))
  })

  it('takes a slower rate, so slow replay needs no new interface', () => {
    const platform = fakePlatform()
    const engine = createWebSpeechEngine()

    engine.speak({ text: 'Hello', language: 'en', rate: 0.8 })

    expect(platform.spoken[0]?.rate).toBe(0.8)
  })

  it('has nothing to say for an empty line', () => {
    const platform = fakePlatform()
    const engine = createWebSpeechEngine()

    expect(engine.speak({ text: '   ', language: 'en' })).toBe(false)
    expect(platform.spoken).toHaveLength(0)
  })

  it('drops back to nothing when the line ends', () => {
    const platform = fakePlatform()
    const engine = createWebSpeechEngine()
    engine.speak({ text: 'Hello', language: 'en' })

    platform.spoken[0]?.onend?.()

    expect(engine.current()).toBeNull()
  })

  it('does not stay stuck when the voice fails mid-way', () => {
    const platform = fakePlatform()
    const engine = createWebSpeechEngine()
    engine.speak({ text: 'Hello', language: 'en' })

    platform.spoken[0]?.onerror?.()

    expect(engine.current()).toBeNull()
  })

  it('reads one line at a time', () => {
    const platform = fakePlatform()
    const engine = createWebSpeechEngine()

    engine.speak({ text: 'first', language: 'en' })
    engine.speak({ text: 'second', language: 'en' })

    expect(platform.spoken).toHaveLength(2)
    // The first line is cut off rather than layered over.
    expect(platform.cancels).toBeGreaterThanOrEqual(1)
    expect(engine.current()).toBe(speakKey('second', 'en'))
  })

  it('fails quietly when the platform refuses to start', () => {
    fakePlatform({ refuse: true })
    const engine = createWebSpeechEngine()

    expect(engine.speak({ text: 'Hello', language: 'en' })).toBe(false)
    expect(engine.current()).toBeNull()
  })

  it('tells every listener on each start and stop', () => {
    const platform = fakePlatform()
    const engine = createWebSpeechEngine()
    const listener = vi.fn()
    const unsubscribe = engine.subscribe(listener)

    engine.speak({ text: 'Hello', language: 'en' })
    platform.spoken[0]?.onend?.()
    engine.cancel()
    unsubscribe()
    engine.speak({ text: 'Hello', language: 'en' })

    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('speakKey', () => {
  it('separates the same words in two languages', () => {
    expect(speakKey('pain', 'en')).not.toBe(speakKey('pain', 'fr'))
  })

  it('folds the padding the platform would have trimmed anyway', () => {
    expect(speakKey(' hello ', 'en')).toBe(speakKey('hello', 'en'))
  })
})

