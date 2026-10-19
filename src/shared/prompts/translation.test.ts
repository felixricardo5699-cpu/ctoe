import { describe, expect, it } from 'vitest'
import { LANGUAGES, SUPPORTED_LANGUAGES, type LanguageCode } from '../language/registry'
import { TONES, type TaskKind, type Tone, type TranslationRequest } from '../types'
import { languageContext, type LanguageContext } from './languageContext'
import { buildAnalysisPrompt, buildExpressionPrompt, buildPrompt } from './translation'
import { buildUnderstandingPrompt } from './understanding'

/** The exact inputs called out in the project brief, kept here as a regression net. */
export const SAMPLE_INPUTS = [
  '你好',
  '这个事情我觉得没那么简单。',
  '哈哈哈你认真的吗',
  '我不同意你的观点。',
  '这个 URL 不要修改：https://example.com',
  'Hello 你好'
]

function request(
  text: string,
  tone: Tone = 'natural',
  source: LanguageCode = 'zh',
  target: LanguageCode = 'en'
): TranslationRequest {
  return { task: 'express', text, tone, context: '', sourceLanguage: source, targetLanguage: target }
}

function analysisRequest(text: string, result: string): TranslationRequest {
  return { ...request(text), task: 'analyze', result }
}

/**
 * The app sends the pair the other way round for 'understand': the source is the language
 * being read (and learned), and the answer comes back in the user's own language.
 */
function understandRequest(text: string): TranslationRequest {
  return { ...request(text, 'natural', 'en', 'zh'), task: 'understand' }
}

/**
 * The context the dispatcher would build, for the tests that call a builder directly.
 * The defaults are the shipped pair; an 'understand' request passes it reversed, because
 * the text being read is the language being learned and the answer is the user's own.
 */
function contextOf(task: TaskKind, source: LanguageCode = 'zh', target: LanguageCode = 'en'): LanguageContext {
  return languageContext({ task, sourceLanguage: source, targetLanguage: target })
}

describe('expression prompt', () => {
  it('asks for the natural wording, not a literal translation', () => {
    const system = buildExpressionPrompt('natural', contextOf('express'))
    expect(system).toContain('natural English')
    expect(system).toContain('Do not translate literally')
    expect(system).toContain('native English speaker would naturally write')
  })

  it('protects meaning, facts, intent, emotion, tone, certainty, intensity and opinion', () => {
    const system = buildExpressionPrompt('natural', contextOf('express'))
    for (const word of ['meaning', 'facts', 'intent', 'emotion', 'certainty', 'intensity', 'opinion']) {
      expect(system).toContain(word)
    }
    expect(system).toContain('Do not add information')
    expect(system).toContain('do not drop meaningful information')
    expect(system).toContain('do not invent facts')
    expect(system).toContain('do not exaggerate and do not soften')
  })

  it('demands output-only text (no explanation, no wrapping quotes)', () => {
    expect(buildExpressionPrompt('natural', contextOf('express'))).toContain(
      'no quotes, no labels, no explanations'
    )
  })

  it('stays short, because long prompts cost tokens and latency', () => {
    for (const tone of TONES) {
      expect(buildExpressionPrompt(tone, contextOf('express')).length).toBeLessThan(1200)
    }
  })

  it('adds exactly one tone instruction', () => {
    const ctx = contextOf('express')
    expect(buildExpressionPrompt('natural', ctx)).toContain('natural, neutral English')
    expect(buildExpressionPrompt('casual', ctx)).toContain('casual, conversational English')
    expect(buildExpressionPrompt('professional', ctx)).toContain('clear, polite, professional English')
  })

  it('passes user text through untouched', () => {
    for (const text of SAMPLE_INPUTS) {
      expect(buildPrompt(request(text)).user).toContain(text)
    }
  })

  it('keeps URLs, emoji, mentions, hashtags and line breaks intact', () => {
    const text = '看这个 https://example.com/path?a=1 😂\n第二行 @someone #tag'
    const { user } = buildPrompt(request(text))
    expect(user).toContain('https://example.com/path?a=1')
    expect(user).toContain('😂')
    expect(user).toContain('@someone')
    expect(user).toContain('#tag')
    expect(user.split('\n').length).toBe(3)
  })

  it('omits context while v1 keeps it empty, and includes it when set', () => {
    expect(buildPrompt(request('你好')).user).not.toContain('Context:')
    expect(buildPrompt({ ...request('你好'), context: 'X 上的回复' }).user).toContain('Context: X 上的回复')
  })
})

describe('analysis prompt', () => {
  it('pins a machine-readable shape instead of prose', () => {
    const system = buildAnalysisPrompt(contextOf('analyze'))
    expect(system).toContain('{"items":[')
    expect(system).toContain('ONE JSON object')
    expect(system).toContain('no code fence')
  })

  it('ranks by usefulness and keeps grammar for when it really is the lesson', () => {
    const system = buildAnalysisPrompt(contextOf('analyze'))
    expect(system).toContain('useful expression > sentence pattern > vocabulary > grammar')
    expect(system).toContain('Add a grammar point only when the structure itself is the lesson')
  })

  it('asks for short meanings and examples in the pair being learned', () => {
    const system = buildAnalysisPrompt(contextOf('analyze'))
    expect(system).toContain('the Chinese meaning')
    expect(system).toContain('natural English sentence')
  })

  it('lets the sentence decide how many points it deserves, with no fixed three', () => {
    const system = buildAnalysisPrompt(contextOf('analyze'))
    expect(system).toContain('Let the sentence decide how many')
    expect(system).toContain('never pad, never drop a useful point')
    expect(system).not.toContain('1-3 things')
    expect(system).not.toContain('never return more than 3 items')
  })

  it('asks for an importance hint on every point, low ones included', () => {
    const system = buildAnalysisPrompt(contextOf('analyze'))
    expect(system).toContain('"importance":"high"')
    expect(system).toContain('importance: "high", "medium" or "low"')
  })

  it('stays short, so Learn can never turn into a lesson', () => {
    expect(buildAnalysisPrompt(contextOf('analyze')).length).toBeLessThan(1200)
  })

  it('asks for every example to carry its own translation', () => {
    // "How is it used" is not answered by a sentence the learner cannot read back.
    const system = buildAnalysisPrompt(contextOf('analyze'))
    expect(system).toContain('"exampleTranslation":"..."')
    expect(system).toContain('exampleTranslation: the same sentence in Chinese.')
  })

  it('sends both what the user meant and the expression they got', () => {
    const { user } = buildPrompt(analysisRequest('我觉得这个想法挺有意思', 'I think it is pretty interesting'))
    expect(user).toContain('我觉得这个想法挺有意思')
    expect(user).toContain('I think it is pretty interesting')
    expect(user).toContain('Tone: natural')
  })

  it('routes by task, so the two prompts never leak into each other', () => {
    const express = buildPrompt(request('你好'))
    const analyze = buildPrompt(analysisRequest('你好', 'Hi there'))
    expect(express.system).not.toBe(analyze.system)
    expect(express.user).not.toContain('Natural English:')
    expect(analyze.user).toContain('Natural English:')
  })
})

describe('understanding prompt', () => {
  it('pins the same machine-readable shape, with the meaning first', () => {
    const system = buildUnderstandingPrompt(contextOf('understand', 'en', 'zh'))
    expect(system).toContain('{"meaning":"..."')
    expect(system).toContain('ONE JSON object')
    expect(system).toContain('no code fence')
  })

  it('asks for the meaning in the reader own language, not a word-for-word rendering', () => {
    const system = buildUnderstandingPrompt(contextOf('understand', 'en', 'zh'))
    expect(system).toContain('in natural Chinese')
    expect(system).toContain('Never translate word for word')
    expect(system).toContain('keep the tone of the original')
  })

  it('teaches from the text instead of explaining every word', () => {
    const system = buildUnderstandingPrompt(contextOf('understand', 'en', 'zh'))
    expect(system).toContain('useful expression > sentence pattern > vocabulary > grammar')
    expect(system).toContain('Do not explain every word')
    expect(system).not.toContain('never return more than 3 items')
    expect(system.length).toBeLessThan(1500)
  })

  it('lets the text decide how many points it deserves, with the same importance hint', () => {
    const system = buildUnderstandingPrompt(contextOf('understand', 'en', 'zh'))
    expect(system).toContain('Let the text decide how many')
    expect(system).toContain('never pad, never drop a useful point')
    expect(system).toContain('"importance":"high"')
    expect(system).not.toContain('1-3 things')
  })

  it('asks for the same example pair in the reading direction', () => {
    const system = buildUnderstandingPrompt(contextOf('understand', 'en', 'zh'))

    expect(system).toContain('"exampleTranslation":"..."')
    expect(system).toContain('exampleTranslation: the same sentence in Chinese.')
  })

  it('sends the text that was read, with no tone instruction attached', () => {
    const { user } = buildPrompt(understandRequest('I was going to join you, but something came up.'))
    expect(user).toContain('English I read:')
    expect(user).toContain('something came up')
    // Tone is about producing the learning language; this direction is about understanding it.
    expect(user).not.toContain('Tone:')
  })

  it('routes by task, so Understand never inherits the rewrite instructions', () => {
    const express = buildPrompt(request('你好'))
    const understand = buildPrompt(understandRequest('Hello there'))
    expect(understand.system).not.toBe(express.system)
    expect(express.system).not.toContain('"meaning"')
    expect(understand.system).not.toContain('Output only the English text')
  })
})

describe('multi-language prompts', () => {
  /** The pairs the brief asks for, spelled out so a regression names the pair it broke. */
  const PAIRS: ReadonlyArray<[LanguageCode, LanguageCode]> = [
    ['zh', 'en'],
    ['en', 'zh'],
    ['fr', 'en'],
    ['en', 'fr'],
    ['es', 'en'],
    ['en', 'es'],
    ['ru', 'en'],
    ['en', 'ru'],
    ['ar', 'en'],
    ['en', 'ar'],
    ['zh', 'fr'],
    ['fr', 'zh'],
    ['es', 'fr'],
    ['fr', 'es'],
    ['ru', 'zh'],
    ['zh', 'ru'],
    ['ar', 'fr'],
    ['fr', 'ar']
  ]

  it('names both languages of the pair in the system prompt', () => {
    for (const [source, target] of PAIRS) {
      const context = contextOf('express', source, target)
      const system = buildExpressionPrompt('natural', context)
      expect(system).toContain(context.learningName)
      expect(system).toContain(context.nativeName)
      expect(system).toContain('Do not translate literally')
    }
  })

  it('never falls back to the shipped pair when another one is configured', () => {
    const system = buildExpressionPrompt('natural', contextOf('express', 'fr', 'es'))
    expect(system).toContain('Spanish')
    expect(system).toContain('French')
    expect(system).not.toContain('Chinese')
    expect(system).not.toContain('English')
  })

  it('keeps the label of the text the user actually wrote', () => {
    const { user } = buildPrompt(request('Bonjour tout le monde', 'natural', 'fr', 'en'))
    expect(user).toContain('What I want to say (French):')
    expect(user).toContain('Bonjour tout le monde')
  })

  it('coaches in the user own language and produces the language being learned', () => {
    const { system } = buildPrompt(analysisRequest('我本来想去', 'I was going to go'))
    expect(system).toContain('for a Chinese speaker who writes English online')
    const writing = buildPrompt({ ...request('Bonjour', 'natural', 'fr', 'es'), task: 'analyze', result: 'Hola' })
    expect(writing.system).toContain('for a French speaker who writes Spanish online')
    // Reading is the same pair backwards, so the roles swap with it.
    const reading = buildPrompt(understandRequest('Bonjour')).system
    expect(reading).toContain('for a Chinese speaker who reads English online')
  })

  it('names the reader own language on the example translation of any pair', () => {
    const spanish = buildUnderstandingPrompt(
      languageContext({ task: 'understand', sourceLanguage: 'es', targetLanguage: 'ru' })
    )

    expect(spanish).toContain('exampleTranslation: the same sentence in Russian.')
    expect(spanish).not.toContain('in Chinese.')
  })

  it('writes the meaning in the user language and the examples in the learning one', () => {
    const spanish = buildUnderstandingPrompt(languageContext({ task: 'understand', sourceLanguage: 'es', targetLanguage: 'ru' }))
    expect(spanish).toContain('in natural Russian')
    expect(spanish).toContain('natural Spanish sentence')
    expect(spanish).not.toContain('Chinese')
  })

  it('tells the model about RTL text without adding a second instruction set', () => {
    const arabic = buildPrompt(request('مرحبا', 'natural', 'ar', 'en'))
    expect(arabic.system).toContain('Arabic')
    expect(arabic.user).toContain('مرحبا')
    expect(arabic.user).toContain('What I want to say (Arabic):')
  })

  it('has a name for every code in the registry', () => {
    for (const language of SUPPORTED_LANGUAGES) {
      const system = buildExpressionPrompt('natural', contextOf('express', language.code, 'en'))
      expect(system).toContain(language.name)
    }
    expect(LANGUAGES.length).toBeGreaterThanOrEqual(6)
  })
})
