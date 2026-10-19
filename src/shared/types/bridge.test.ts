import { describe, expect, it } from 'vitest'
import {
  BRIDGE_MAX_TITLE_CHARS,
  BRIDGE_MAX_URL_CHARS,
  BRIDGE_PORTS,
  BRIDGE_PORT_FIRST,
  BRIDGE_PORT_LAST,
  BRIDGE_PROTOCOL_VERSION,
  isBridgeErrorCode,
  isBridgeLearnMode,
  isBridgeRequestId,
  readLanguageHint,
  resolveBridgeMode,
  sanitizeBridgeLearnRequest
} from './bridge'

/** The profile every direction test runs against: a Chinese speaker learning English. */
const PROFILE = { nativeLanguage: 'zh', learningLanguage: 'en' } as const

describe('bridge: the port range', () => {
  it('is a closed range both ends agree on', () => {
    expect(BRIDGE_PORTS[0]).toBe(BRIDGE_PORT_FIRST)
    expect(BRIDGE_PORTS[BRIDGE_PORTS.length - 1]).toBe(BRIDGE_PORT_LAST)
    expect(BRIDGE_PORTS).toHaveLength(BRIDGE_PORT_LAST - BRIDGE_PORT_FIRST + 1)
    expect(new Set(BRIDGE_PORTS).size).toBe(BRIDGE_PORTS.length)
  })
})

describe('bridge: reading a page language tag', () => {
  it('reads a tag down to the language the registry knows', () => {
    expect(readLanguageHint('en-US')).toBe('en')
    expect(readLanguageHint('zh-Hant')).toBe('zh')
    expect(readLanguageHint('FR')).toBe('fr')
    expect(readLanguageHint('ru_RU')).toBe('ru')
    expect(readLanguageHint('  es  ')).toBe('es')
  })

  it('reads anything it cannot place as no hint at all', () => {
    // A language this app does not teach, an empty tag, and a value that is not a tag.
    expect(readLanguageHint('klingon')).toBeNull()
    expect(readLanguageHint('')).toBeNull()
    expect(readLanguageHint('   ')).toBeNull()
    expect(readLanguageHint(undefined)).toBeNull()
    expect(readLanguageHint(5)).toBeNull()
  })
})

describe('bridge: which direction a request runs in', () => {
  it('takes the extension at its word when it names a direction', () => {
    expect(resolveBridgeMode('express', 'en', PROFILE)).toBe('express')
    expect(resolveBridgeMode('understand', 'zh', PROFILE)).toBe('understand')
  })

  it('reads a hint that names the language being learned as reading', () => {
    expect(resolveBridgeMode(undefined, 'en-GB', PROFILE)).toBe('understand')
  })

  it('reads a hint that names the user own language as producing', () => {
    expect(resolveBridgeMode(undefined, 'zh', PROFILE)).toBe('express')
  })

  it('falls back to reading for a hint it cannot place, or none at all', () => {
    // Reading is the safe default: it is what pointing at a sentence on a page means, and it only
    // ever translates the text the user actually looked at.
    expect(resolveBridgeMode(undefined, undefined, PROFILE)).toBe('understand')
    expect(resolveBridgeMode(undefined, 'klingon', PROFILE)).toBe('understand')
    // A hint naming neither side of this user's relation says nothing about this request.
    expect(resolveBridgeMode(undefined, 'fr', PROFILE)).toBe('understand')
  })

  it('never lets a hint contradict the profile it was resolved against', () => {
    // The extension cannot know the profile, so the same hint means opposite things to two users.
    const frenchSpeaker = { nativeLanguage: 'fr', learningLanguage: 'en' } as const
    expect(resolveBridgeMode(undefined, 'zh', PROFILE)).toBe('express')
    expect(resolveBridgeMode(undefined, 'zh', frenchSpeaker)).toBe('understand')
  })

  it('reads the direction from the sentence itself when the page never said', () => {
    // PROFILE is a Chinese speaker learning English, so a Latin sentence is the language being
    // learned and a Chinese one is the user's own. This is the case a page with no `lang`
    // attribute used to get wrong: pointing at Chinese text was coached as if it were English.
    expect(resolveBridgeMode(undefined, undefined, PROFILE, 'I was going to join you.')).toBe('understand')
    expect(resolveBridgeMode(undefined, undefined, PROFILE, '我觉得这个想法挺有意思。')).toBe('express')
    // The same two sentences for someone learning Chinese: the answer is the mirror image, which
    // is what makes this a rule about the profile rather than about the text.
    const learner = { nativeLanguage: 'en', learningLanguage: 'zh' } as const
    expect(resolveBridgeMode(undefined, undefined, learner, 'I was going to join you.')).toBe('express')
    expect(resolveBridgeMode(undefined, undefined, learner, '我觉得这个想法挺有意思。')).toBe('understand')
  })

  it('keeps reading when the script cannot name a side of the pair', () => {
    // English, French and Spanish are all Latin: the sentence says nothing about which side of
    // that pair it belongs to, so the conservative default stands.
    const frenchSpeaker = { nativeLanguage: 'fr', learningLanguage: 'en' } as const
    expect(resolveBridgeMode(undefined, undefined, frenchSpeaker, 'Bonjour tout le monde.')).toBe('understand')
    // A third language is not a side of this relation either.
    expect(resolveBridgeMode(undefined, undefined, PROFILE, 'Привет, как дела?')).toBe('understand')
    expect(resolveBridgeMode(undefined, undefined, PROFILE, '')).toBe('understand')
  })

  it('lets a page tag win over the sentence script', () => {
    // A page that says `lang="en"` is making a deliberate statement about its own content, and a
    // quote inside it is the case the tag describes; the script only fills the silence.
    expect(resolveBridgeMode(undefined, 'en', PROFILE, '我觉得这个想法挺有意思。')).toBe('understand')
    expect(resolveBridgeMode('express', undefined, PROFILE, 'I was going to join you.')).toBe('express')
  })
})

describe('bridge: a request id', () => {
  it('accepts a short printable token and rejects anything else', () => {
    expect(isBridgeRequestId('abc-123:ok.1')).toBe(true)
    expect(isBridgeRequestId(' '.repeat(1) + 'x')).toBe(true)
    expect(isBridgeRequestId('')).toBe(false)
    expect(isBridgeRequestId('   ')).toBe(false)
    expect(isBridgeRequestId('a'.repeat(65))).toBe(false)
    expect(isBridgeRequestId('has space')).toBe(false)
    expect(isBridgeRequestId('line\nbreak')).toBe(false)
    expect(isBridgeRequestId(42)).toBe(false)
  })
})

describe('bridge: the body of a learn request', () => {
  it('keeps what it can act on and drops everything else', () => {
    const request = sanitizeBridgeLearnRequest({
      requestId: 'r1',
      text: '  I   had no idea   they would come together.  ',
      mode: 'understand',
      langHint: 'en-US',
      url: 'https://example.com/a',
      title: 'Example',
      // Not part of the protocol: a field the app does not know is not one it trusts.
      knowledgePoints: [{ expression: 'sneaky' }]
    })

    expect(request).toEqual({
      requestId: 'r1',
      text: 'I had no idea they would come together.',
      mode: 'understand',
      langHint: 'en',
      url: 'https://example.com/a',
      title: 'Example'
    })
    expect(request !== null && 'knowledgePoints' in request).toBe(false)
  })

  it('leaves out the optional fields the request did not carry', () => {
    expect(sanitizeBridgeLearnRequest({ requestId: 'r1', text: 'Hello.' })).toEqual({
      requestId: 'r1',
      text: 'Hello.'
    })
  })

  it('refuses a body it cannot act on, rather than inventing the missing half', () => {
    // No id: a second copy of the same sentence could not be told apart from this one.
    expect(sanitizeBridgeLearnRequest({ text: 'Hello.' })).toBeNull()
    expect(sanitizeBridgeLearnRequest({ requestId: '   ', text: 'Hello.' })).toBeNull()
    // No text: there is nothing to learn.
    expect(sanitizeBridgeLearnRequest({ requestId: 'r1', text: '' })).toBeNull()
    expect(sanitizeBridgeLearnRequest({ requestId: 'r1', text: '   ' })).toBeNull()
    expect(sanitizeBridgeLearnRequest({ requestId: 'r1', text: 7 })).toBeNull()
    expect(sanitizeBridgeLearnRequest(null)).toBeNull()
    expect(sanitizeBridgeLearnRequest('r1')).toBeNull()
  })

  it('drops a direction or a hint that is not one of the known values', () => {
    const request = sanitizeBridgeLearnRequest({
      requestId: 'r1',
      text: 'Hello.',
      mode: 'guess',
      langHint: 'klingon'
    })
    expect(request).toEqual({ requestId: 'r1', text: 'Hello.' })
  })

  it('cuts an over-long url or title instead of passing it through', () => {
    const request = sanitizeBridgeLearnRequest({
      requestId: 'r1',
      text: 'Hello.',
      url: 'u'.repeat(BRIDGE_MAX_URL_CHARS + 100),
      title: 't'.repeat(BRIDGE_MAX_TITLE_CHARS + 100)
    })
    expect(request?.url).toHaveLength(BRIDGE_MAX_URL_CHARS)
    expect(request?.title).toHaveLength(BRIDGE_MAX_TITLE_CHARS)
  })

  it('keeps the sentence even when the page details are unusable', () => {
    const request = sanitizeBridgeLearnRequest({ requestId: 'r1', text: 'Hello.', url: '  ', title: 9 })
    expect(request).toEqual({ requestId: 'r1', text: 'Hello.' })
  })
})

describe('bridge: the vocabulary of the protocol', () => {
  it('knows its own error codes and nothing else', () => {
    expect(isBridgeErrorCode('unauthorized')).toBe(true)
    expect(isBridgeErrorCode('bridge-off')).toBe(true)
    expect(isBridgeErrorCode('language-pair-id-exhausted')).toBe(true)
    expect(isBridgeErrorCode('surprise')).toBe(false)
    expect(isBridgeErrorCode(undefined)).toBe(false)
  })

  it('knows its own directions and nothing else', () => {
    expect(isBridgeLearnMode('understand')).toBe(true)
    expect(isBridgeLearnMode('express')).toBe(true)
    expect(isBridgeLearnMode('analyze')).toBe(false)
  })

  it('states a protocol version the health answer can carry', () => {
    expect(BRIDGE_PROTOCOL_VERSION).toBeGreaterThan(0)
    expect(Number.isInteger(BRIDGE_PROTOCOL_VERSION)).toBe(true)
  })
})
