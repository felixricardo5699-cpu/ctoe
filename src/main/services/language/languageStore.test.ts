import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LANGUAGE_PAIR_ID_EXHAUSTED, SentenceIdExhaustedError, formatSentenceId } from '@shared/language/sentenceId'
import type { LearningItem, SavedSentence, SavedSentenceDraft } from '@shared/types'
import { LanguageStore } from './languageStore'

// Only the default path uses Electron; these tests always pass an explicit file.
vi.mock('electron', () => ({ app: { getPath: () => 'test-user-data' } }))

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctoe-language-'))
  dirs.push(dir)
  return join(dir, 'learned.json')
}

function point(expression: string, kind: LearningItem['kind'] = 'expression'): LearningItem {
  return {
    kind,
    expression,
    meaning: '含义 ' + expression,
    why: '为什么要记住',
    example: 'An example with ' + expression + '.',
    exampleTranslation: '含有 ' + expression + ' 的例句。'
  }
}

/** A v5 record as the file holds it: no relation recorded, and an epoch-ish ISO time. */
function v5Record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    originalText: '我本来想去',
    translatedText: 'I was going to go.',
    tone: 'natural',
    sourceLanguage: 'en',
    targetLanguage: 'zh',
    learningLanguage: 'zh',
    savedAt: '2026-09-24T00:00:00.000Z',
    knowledgePoints: [],
    ...overrides
  }
}

/** One moment as the panel hands it over: the two lines, the relation, and what was found in it. */
function draft(overrides: Partial<SavedSentenceDraft> = {}): SavedSentenceDraft {
  return {
    originalText: '我觉得这个想法挺有意思',
    translatedText: 'I think the idea is pretty interesting.',
    tone: 'natural',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    knowledgePoints: [point('pretty interesting')],
    ...overrides
  }
}

/** One v4 record: a single point with the sentence it came from, saved as epoch milliseconds. */
function legacyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'v4-' + String(overrides.id ?? 'a'),
    sourceText: '我本来想去',
    targetText: 'I was going to go.',
    tone: 'natural',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    items: [point('I was going to', 'pattern')],
    savedAt: 1_700_000_000_000,
    ...overrides
  }
}

function writeLegacy(file: string, body: unknown): void {
  writeFileSync(file, JSON.stringify(body, null, 2) + '\n', 'utf8')
}

function stored(file: string): { version?: unknown; languages?: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(file, 'utf8')) as {
    version?: unknown
    languages?: Record<string, Record<string, unknown>>
  }
}

function expressions(points: readonly { expression: string }[]): string[] {
  return points.map((entry) => entry.expression)
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('LanguageStore: the sentence is what is saved', () => {
  it('starts empty when there is no file yet', () => {
    expect(LanguageStore.open(tempFile()).list()).toEqual([])
  })

  it('keeps the whole sentence, its points, an id and both ISO timestamps', () => {
    const listed = LanguageStore.open(tempFile()).save(draft())

    expect(listed).toHaveLength(1)
    const saved = listed[0] as SavedSentence
    expect(saved).toMatchObject({
      id: 1,
      originalText: '我觉得这个想法挺有意思',
      translatedText: 'I think the idea is pretty interesting.',
      tone: 'natural',
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      learningLanguage: 'en'
    })
    expect(formatSentenceId(saved.id)).toBe('#000001')
    expect(expressions(saved.knowledgePoints)).toEqual(['pretty interesting'])
    // ISO-8601 strings, not epoch milliseconds: the format the file keeps from now on.
    expect(saved.savedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(saved.createdAt).toBe(saved.savedAt)
  })

  it('keeps every point the answer found, with no product cap', () => {
    const many = [
      point('run a business'),
      point('sign up for', 'expression'),
      point('ahead of time', 'expression'),
      point('have no idea how', 'pattern'),
      point('pay for', 'vocabulary'),
      point('teapot cozy', 'vocabulary')
    ]
    const listed = LanguageStore.open(tempFile()).save(draft({ knowledgePoints: many }))

    // Six points, not three: how many a sentence deserves is the answer's business.
    expect(listed[0]?.knowledgePoints).toHaveLength(6)
    expect(expressions(listed[0]?.knowledgePoints ?? [])).toEqual([
      'run a business',
      'sign up for',
      'ahead of time',
      'have no idea how',
      'pay for',
      'teapot cozy'
    ])
  })

  it('keeps a simple sentence that has only one point', () => {
    const listed = LanguageStore.open(tempFile()).save(
      draft({ originalText: '我累了', translatedText: 'I am tired.', knowledgePoints: [point('tired', 'vocabulary')] })
    )

    expect(listed[0]?.knowledgePoints).toHaveLength(1)
    expect(listed[0]?.knowledgePoints[0]?.expression).toBe('tired')
  })

  it('keeps a sentence even when the answer found nothing to teach', () => {
    const listed = LanguageStore.open(tempFile()).save(draft({ knowledgePoints: [] }))

    expect(listed).toHaveLength(1)
    expect(listed[0]?.knowledgePoints).toEqual([])
  })

  it('stamps every point with the language it is read in', () => {
    const listed = LanguageStore.open(tempFile()).save(
      draft({ sourceLanguage: 'zh', targetLanguage: 'fr', learningLanguage: 'fr' })
    )

    // The studied side, frozen at save time: switching what the user learns tomorrow must not
    // change how an old line is spoken.
    expect(listed[0]?.knowledgePoints[0]?.audioLanguage).toBe('fr')
  })

  it('gives every point its own id, and the default rank when the answer did not rank it', () => {
    const listed = LanguageStore.open(tempFile()).save(
      draft({ knowledgePoints: [point('a'), point('b')] })
    )
    const points = listed[0]?.knowledgePoints ?? []

    expect(points[0]?.id).not.toBe(points[1]?.id)
    expect(points[0]?.id.length).toBeGreaterThan(0)
    expect(points[0]?.importance).toBe('medium')
  })

  it('keeps nothing unless Save was pressed, and writes the current shape when it is', () => {
    const file = tempFile()
    const store = LanguageStore.open(file)
    expect(store.list()).toEqual([])

    store.save(draft())
    const onDisk = stored(file)
    expect(onDisk.version).toBe(7)
    const pair = onDisk.languages?.zh?.en as { nextId: number; records: SavedSentence[] }
    expect(pair.nextId).toBe(2)
    expect(pair.records[0]?.originalText).toBe('我觉得这个想法挺有意思')
    expect(pair.records[0]?.knowledgePoints[0]?.expression).toBe('pretty interesting')
  })
})

describe('LanguageStore: saving the same moment again', () => {
  it('refreshes the sentence instead of stacking a duplicate', () => {
    const store = LanguageStore.open(tempFile())
    const id = store.save(draft())[0]?.id

    const listed = store.save(draft({ tone: 'casual' }))

    expect(listed).toHaveLength(1)
    expect(listed[0]?.id).toBe(id)
    expect(listed[0]?.tone).toBe('casual')
  })

  it('keeps createdAt where it was and moves savedAt forward', () => {
    const store = LanguageStore.open(tempFile())
    const first = store.save(draft())[0] as SavedSentence
    const second = store.save(draft())[0] as SavedSentence

    expect(second.createdAt).toBe(first.createdAt)
    expect(second.id).toBe(first.id)
  })

  it('merges the points a second Learn pass found into the sentence', () => {
    const store = LanguageStore.open(tempFile())
    store.save(draft({ knowledgePoints: [point('sign up for')] }))
    const listed = store.save(draft({ knowledgePoints: [point('ahead of time')] }))

    // One moment, both things worth learning out of it - never two copies of the moment, and
    // never a point dropped by the second save.
    expect(listed).toHaveLength(1)
    expect(expressions(listed[0]?.knowledgePoints ?? [])).toEqual(['sign up for', 'ahead of time'])
  })

  it('dedupes a point that comes back written differently', () => {
    const store = LanguageStore.open(tempFile())
    store.save(draft({ knowledgePoints: [point('sign up for')] }))
    const listed = store.save(draft({ knowledgePoints: [point('  Sign   Up For ')] }))

    expect(listed[0]?.knowledgePoints).toHaveLength(1)
  })

  it('keeps the same words under a different kind as two points', () => {
    const store = LanguageStore.open(tempFile())
    store.save(draft({ knowledgePoints: [point('sign up for', 'expression')] }))
    const listed = store.save(draft({ knowledgePoints: [point('sign up for', 'vocabulary')] }))

    expect(listed[0]?.knowledgePoints).toHaveLength(2)
  })

  it('treats the same words under another relation as a second sentence', () => {
    const store = LanguageStore.open(tempFile())
    store.save(draft())
    // Same words, another relation: a user following two languages keeps both.
    store.save(draft({ targetLanguage: 'fr', learningLanguage: 'fr' }))

    expect(store.list()).toHaveLength(2)
  })

  it('keeps the two directions of one relation as two moments on one shelf', () => {
    const store = LanguageStore.open(tempFile())
    // Say it: what the user brought is their own language.
    store.save(draft({ originalText: '我本来想去', translatedText: 'I was going to go.' }))
    // Understand: the same two lines read the other way round are a different moment, and it is the
    // same relation - so it shares the same id sequence instead of starting its own.
    store.save(
      draft({
        sourceLanguage: 'en',
        targetLanguage: 'zh',
        originalText: 'I was going to go.',
        translatedText: '我本来想去'
      })
    )

    const listed = store.list()
    expect(listed).toHaveLength(2)
    expect(listed.map((sentence) => [sentence.sourceLanguage, sentence.id])).toEqual([
      ['en', 2],
      ['zh', 1]
    ])
    expect(listed.every((sentence) => sentence.nativeLanguage === 'zh')).toBe(true)
  })
})

describe('LanguageStore: ids belong to one relation', () => {
  it('numbers each relation from 1', () => {
    const store = LanguageStore.open(tempFile())
    store.save(draft())
    store.save(draft({ targetLanguage: 'fr', learningLanguage: 'fr' }))
    store.save(draft({ originalText: '第二句' }))

    const byRelation = store.list().map((sentence) => [
      sentence.nativeLanguage,
      sentence.learningLanguage,
      sentence.id
    ])
    expect(byRelation).toContainEqual(['zh', 'en', 1])
    expect(byRelation).toContainEqual(['zh', 'en', 2])
    // Chinese -> French starts over at 1: #000001 exists once per relation, which is the point.
    expect(byRelation).toContainEqual(['zh', 'fr', 1])
  })

  it('persists each relation counter, so a reopen keeps counting', () => {
    const file = tempFile()
    LanguageStore.open(file).save(draft())
    LanguageStore.open(file).save(draft({ originalText: '第二句' }))

    expect(LanguageStore.open(file).list().map((sentence) => sentence.id)).toEqual([2, 1])
  })

  it('never hands a deleted id to the next sentence', () => {
    const store = LanguageStore.open(tempFile())
    store.save(draft({ originalText: '第一句' }))
    const listed = store.save(draft({ originalText: '第二句' }))
    const second = listed[0] as SavedSentence

    const afterDelete = store.remove({
      nativeLanguage: second.nativeLanguage,
      learningLanguage: second.learningLanguage,
      id: second.id
    })
    expect(afterDelete.map((sentence) => sentence.originalText)).toEqual(['第一句'])

    const next = store.save(draft({ originalText: '第三句' }))
    // #000002 is spent for good: the next sentence is #000003, not a fresh #000001.
    expect(next).toHaveLength(2)
    expect(next.map((sentence) => formatSentenceId(sentence.id))).toEqual(['#000003', '#000001'])
  })

  it('refuses to wrap around when a relation has used up its ids', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: { zh: { en: { nextId: 0xffffff + 1, records: [] } } }
    })
    const store = LanguageStore.open(file)

    expect(() => store.save(draft())).toThrow(SentenceIdExhaustedError)
    try {
      store.save(draft())
    } catch (error) {
      expect((error as SentenceIdExhaustedError).code).toBe(LANGUAGE_PAIR_ID_EXHAUSTED)
    }
    // Nothing was written: a refusal must not look like a save.
    expect(LanguageStore.open(file).list()).toEqual([])
  })

  it('still hands out the very last id of the space', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: { zh: { en: { nextId: 0xffffff, records: [] } } }
    })

    const listed = LanguageStore.open(file).save(draft())
    expect(formatSentenceId(listed[0]?.id ?? 0)).toBe('#FFFFFF')
  })
})

describe('LanguageStore: deleting and clearing', () => {
  it('deletes the whole sentence, points and all, from disk as well as memory', () => {
    const store = LanguageStore.open(tempFile())
    store.save(draft({ originalText: '第一句' }))
    const listed = store.save(draft({ originalText: '第二句' }))
    const second = listed[0] as SavedSentence

    const afterDelete = store.remove({
      nativeLanguage: second.nativeLanguage,
      learningLanguage: second.learningLanguage,
      id: second.id
    })

    expect(afterDelete.map((sentence) => sentence.originalText)).toEqual(['第一句'])
    // Reading the file again must not bring it back.
    const reopened = LanguageStore.open(store.path).list()
    expect(reopened.map((sentence) => sentence.originalText)).toEqual(['第一句'])
    expect(reopened[0]?.knowledgePoints).toHaveLength(1)
  })

  it('leaves the counter alone when a relation is emptied', () => {
    const store = LanguageStore.open(tempFile())
    const saved = store.save(draft())[0] as SavedSentence

    store.clear()
    expect(store.list()).toEqual([])

    // The ids already used are still spent, so nothing saved from here can collide with them.
    const next = store.save(draft())
    expect(next[0]?.id).toBe(2)
    expect(next[0]?.id).not.toBe(saved.id)
  })
})

describe('LanguageStore: files it cannot fully trust', () => {
  it('survives a corrupt or hand-edited file', () => {
    const file = tempFile()
    writeFileSync(file, '{ not json', 'utf8')
    expect(LanguageStore.open(file).list()).toEqual([])

    writeFileSync(file, JSON.stringify({ version: 5, languages: 'nope' }), 'utf8')
    expect(LanguageStore.open(file).list()).toEqual([])
  })

  it('drops sentences and points that cannot be read', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        zh: {
          en: {
            nextId: 4,
            records: [
              {
                id: 1,
                originalText: '中文',
                translatedText: 'English',
                tone: 'casual',
                sourceLanguage: 'zh',
                targetLanguage: 'en',
                learningLanguage: 'en',
                knowledgePoints: [point('kept point'), { expression: 'no meaning' }, { meaning: 'no expression' }]
              },
              { id: 2, originalText: '   ', translatedText: '   ', knowledgePoints: [] },
              { originalText: 'no id', translatedText: 'English', knowledgePoints: [] },
              'not an object'
            ]
          }
        }
      }
    })

    const listed = LanguageStore.open(file).list()
    expect(listed).toHaveLength(1)
    expect(expressions(listed[0]?.knowledgePoints ?? [])).toEqual(['kept point'])
    expect(listed[0]?.tone).toBe('casual')
    // The counter is read from the file, not recomputed from what survived.
    expect((stored(file).languages?.zh?.en as { nextId: number }).nextId).toBe(4)
  })

  it('reads a missing rank as the middle one and a missing audio language as the sentence’s', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        fr: {
          en: {
            nextId: 2,
            records: [
              {
                id: 1,
                originalText: 'Bonjour',
                translatedText: 'Hello',
                sourceLanguage: 'fr',
                targetLanguage: 'en',
                learningLanguage: 'fr',
                knowledgePoints: [{ kind: 'expression', expression: 'du coup', meaning: '所以' }]
              }
            ]
          }
        }
      }
    })

    const point0 = LanguageStore.open(file).list()[0]?.knowledgePoints[0]
    expect(point0?.importance).toBe('medium')
    // No audioLanguage in the file: the point is read in the language the sentence teaches.
    expect(point0?.audioLanguage).toBe('fr')
  })

  it('refuses a language that is not in the registry', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        klingon: { en: { nextId: 1, records: [] } },
        zh: {
          7: { nextId: 1, records: [] },
          en: {
            nextId: 2,
            records: [
              {
                id: 1,
                originalText: 'Bonjour',
                translatedText: 'Hello',
                sourceLanguage: 'klingon',
                targetLanguage: 7,
                knowledgePoints: []
              }
            ]
          }
        }
      }
    })

    const learned = LanguageStore.open(file).list()[0]
    expect(learned).toMatchObject({ sourceLanguage: 'zh', targetLanguage: 'en' })
  })

  it('never caps how many sentences a pair can hold', () => {
    const file = tempFile()
    const records = Array.from({ length: 120 }, (_value, index) => ({
      id: index + 1,
      originalText: '中文 ' + String(index),
      translatedText: 'English ' + String(index),
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      learningLanguage: 'en',
      knowledgePoints: []
    }))
    writeLegacy(file, { version: 5, languages: { zh: { en: { nextId: 121, records } } } })

    // The old file dropped everything past 200 records; the id space is the only ceiling now.
    expect(LanguageStore.open(file).list()).toHaveLength(120)
  })
})

describe('LanguageStore: the relation a sentence belongs to', () => {
  /*
   * A sentence carries two facts that must never be confused: the relation it happened in
   * (native + learning) and the direction of that particular moment. The store writes the
   * relation down from now on, and reads it off the direction for files that predate it.
   */

  it('writes the relation down when a sentence is saved', () => {
    // The draft says zh -> en while studying en, so the user speaks zh: that is the relation.
    const file = tempFile()
    const listed = LanguageStore.open(file).save(draft())

    expect(listed[0]?.nativeLanguage).toBe('zh')
    expect(listed[0]?.learningLanguage).toBe('en')
    // On the file as well, not only in memory: that is what makes a saved sentence describe
    // itself instead of being described by whatever the settings happen to say today.
    const pair = stored(file).languages?.zh?.en as { records: SavedSentence[] }
    expect(pair.records[0]?.nativeLanguage).toBe('zh')
  })

  it('reads the relation off the direction of a file that predates the field', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        zh: {
          en: {
            nextId: 2,
            records: [
              {
                id: 1,
                originalText: '我本来打算加入你们',
                translatedText: 'I was going to join you',
                sourceLanguage: 'zh',
                targetLanguage: 'en',
                learningLanguage: 'en',
                knowledgePoints: []
              }
            ]
          }
        }
      }
    })

    expect(LanguageStore.open(file).list()[0]?.nativeLanguage).toBe('zh')
  })

  it('reads the relation of a moment the user was reading, not producing', () => {
    // The studied side is the source here, so the other side is what the user speaks.
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        zh: {
          en: {
            nextId: 1,
            records: [
              {
                id: 1,
                originalText: '我本来打算加入你们',
                translatedText: 'I was going to join you',
                sourceLanguage: 'en',
                targetLanguage: 'zh',
                learningLanguage: 'zh',
                knowledgePoints: []
              }
            ]
          }
        }
      }
    })

    expect(LanguageStore.open(file).list()[0]?.nativeLanguage).toBe('en')
  })

  it('keeps the relation the file states', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        fr: {
          es: {
            nextId: 1,
            records: [
              {
                id: 1,
                nativeLanguage: 'fr',
                originalText: 'Bonjour',
                translatedText: 'Hola',
                sourceLanguage: 'es',
                targetLanguage: 'fr',
                learningLanguage: 'es',
                knowledgePoints: []
              }
            ]
          }
        }
      }
    })

    expect(LanguageStore.open(file).list()[0]?.nativeLanguage).toBe('fr')
  })

  it('does not accept a relation that is the same language on both sides', () => {
    // A sentence cannot be its own mirror: 'learning en' with 'native en' is not a relation, so
    // the direction is what gets read instead.
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        zh: {
          en: {
            nextId: 1,
            records: [
              {
                id: 1,
                nativeLanguage: 'en',
                originalText: '我累了',
                translatedText: 'I am tired',
                sourceLanguage: 'zh',
                targetLanguage: 'en',
                learningLanguage: 'en',
                knowledgePoints: []
              }
            ]
          }
        }
      }
    })

    expect(LanguageStore.open(file).list()[0]?.nativeLanguage).toBe('zh')
  })

  it('gives a v4 record the relation its direction and studied side imply', () => {
    const file = tempFile()
    writeLegacy(file, { version: 4, records: [legacyRecord()] })

    expect(LanguageStore.open(file).list()[0]?.nativeLanguage).toBe('zh')
  })
})

describe('LanguageStore: the upgrade from v4', () => {
  /** Two v4 records for one sentence, which is what "one point per record" produced. */
  const splitSentence = {
    version: 4,
    records: [
      legacyRecord({ id: 'a', savedAt: 2_000, items: [point('did not expect', 'expression')] }),
      legacyRecord({ id: 'b', savedAt: 1_000, items: [point('turn out', 'expression')] })
    ]
  }

  it('turns one point per record back into one sentence with its points', () => {
    const file = tempFile()
    writeLegacy(file, splitSentence)

    const listed = LanguageStore.open(file).list()

    expect(listed).toHaveLength(1)
    expect(listed[0]?.originalText).toBe('我本来想去')
    expect(listed[0]?.translatedText).toBe('I was going to go.')
    // Points arrive in the order the moments happened, which is also how the ids were handed out.
    expect(expressions(listed[0]?.knowledgePoints ?? [])).toEqual(['turn out', 'did not expect'])
    expect(listed[0]?.id).toBe(1)
  })

  it('backs the v4 file up before rewriting it', () => {
    const file = tempFile()
    writeLegacy(file, splitSentence)
    const originalBytes = readFileSync(file, 'utf8')

    LanguageStore.open(file)

    expect(readFileSync(file + '.v4.bak', 'utf8')).toBe(originalBytes)
    expect(stored(file).version).toBe(7)
  })

  it('backs a v5 file up as .v5.bak before filing it by relation', () => {
    const file = tempFile()
    writeLegacy(file, { version: 5, languages: { zh: { en: { nextId: 2, records: [v5Record({ id: 1 })] } } } })
    const originalBytes = readFileSync(file, 'utf8')

    LanguageStore.open(file)
    LanguageStore.open(file)

    expect(stored(file).version).toBe(7)
    // The copy is the file as it really was, and a second open cannot overwrite it with the
    // already-migrated one - that copy is the only record of what the old numbering meant.
    expect(readFileSync(file + '.v5.bak', 'utf8')).toBe(originalBytes)
  })

  it('files a v5 file by relation, with both directions on one shelf and one sequence', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 5,
      languages: {
        en: {
          zh: {
            nextId: 4,
            records: [
              v5Record({ id: 1 }),
              v5Record({ id: 2 }),
              v5Record({ id: 3 })
            ]
          }
        },
        zh: { en: { nextId: 3, records: [v5Record({ id: 2, sourceLanguage: 'zh', targetLanguage: 'en' })] } }
      }
    })

    const listed = LanguageStore.open(file).list()

    // Both buckets handed out a #000002, so one of them has to move: en -> zh keeps 1, 2, 3 and the
    // other one's surviving sentence becomes #000005.
    expect(listed.map((sentence) => sentence.id).sort((left, right) => left - right)).toEqual([1, 2, 3, 5])
    expect(listed.every((sentence) => sentence.nativeLanguage === 'en')).toBe(true)
    expect(listed.every((sentence) => sentence.learningLanguage === 'zh')).toBe(true)
    const buckets = stored(file).languages as Record<string, Record<string, { nextId: number }>>
    expect(Object.keys(buckets)).toEqual(['en'])
    expect(Object.keys(buckets.en ?? {})).toEqual(['zh'])
    expect(buckets.en?.zh?.nextId).toBe(6)
  })

  it('copies the backup once, so a second open keeps the original v4 bytes', () => {
    const file = tempFile()
    writeLegacy(file, splitSentence)
    const originalBytes = readFileSync(file, 'utf8')

    LanguageStore.open(file)
    LanguageStore.open(file)
    LanguageStore.open(file)

    // The backup is still the old shape, not a copy of the already-migrated file.
    expect(readFileSync(file + '.v4.bak', 'utf8')).toBe(originalBytes)
    expect(LanguageStore.open(file).list()).toHaveLength(1)
  })

  it('writes epoch milliseconds out as ISO strings', () => {
    const file = tempFile()
    writeLegacy(file, splitSentence)

    const listed = LanguageStore.open(file).list()

    expect(listed[0]?.savedAt).toBe(new Date(2_000).toISOString())
    // createdAt is when the moment first happened, which is the oldest of the merged records.
    expect(listed[0]?.createdAt).toBe(new Date(1_000).toISOString())
  })

  it('hands out ids oldest first, not in array order', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 4,
      records: [
        legacyRecord({ id: 'newer', sourceText: '第二句', savedAt: 2_000 }),
        legacyRecord({ id: 'older', sourceText: '第一句', savedAt: 1_000 })
      ]
    })

    const listed = LanguageStore.open(file).list()
    // Newest first in the list, but the ids were handed out in the order the moments happened.
    expect(listed.map((sentence) => [sentence.originalText, sentence.id])).toEqual([
      ['第二句', 2],
      ['第一句', 1]
    ])
    expect((stored(file).languages?.zh?.en as { nextId: number }).nextId).toBe(3)
  })

  it('gives each language relation its own ids', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 4,
      records: [
        legacyRecord({ id: 'en', savedAt: 1_000 }),
        legacyRecord({ id: 'fr', savedAt: 2_000, targetLanguage: 'fr', learningLanguage: 'fr' })
      ]
    })

    const listed = LanguageStore.open(file).list()
    expect(listed.map((sentence) => [sentence.learningLanguage, sentence.id])).toEqual([
      ['fr', 1],
      ['en', 1]
    ])
  })

  it('dedupes points that came back twice under one sentence', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 4,
      records: [
        legacyRecord({ id: 'a', savedAt: 1_000, items: [point('figure out')] }),
        legacyRecord({ id: 'b', savedAt: 2_000, items: [point('Figure  Out')] })
      ]
    })

    expect(expressions(LanguageStore.open(file).list()[0]?.knowledgePoints ?? [])).toEqual([
      'figure out'
    ])
  })

  it('keeps both points when the same words carry a different kind', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 4,
      records: [
        legacyRecord({ id: 'a', savedAt: 1_000, items: [point('sign up for', 'expression')] }),
        legacyRecord({ id: 'b', savedAt: 2_000, items: [point('sign up for', 'vocabulary')] })
      ]
    })

    expect(LanguageStore.open(file).list()[0]?.knowledgePoints).toHaveLength(2)
  })

  it('reads the studied side off the most recent record of the moment', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 4,
      records: [
        legacyRecord({ id: 'a', savedAt: 1_000, learningLanguage: 'en' }),
        legacyRecord({ id: 'b', savedAt: 2_000, learningLanguage: 'zh' })
      ]
    })

    expect(LanguageStore.open(file).list()[0]?.learningLanguage).toBe('zh')
  })

  it('gives a file older than the registry the shipped pair', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 2,
      records: [
        {
          id: 'old-2',
          sourceText: '我本来想去',
          targetText: 'I was going to go.',
          tone: 'natural',
          items: [],
          savedAt: 7
        }
      ]
    })

    expect(LanguageStore.open(file).list()[0]).toMatchObject({
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      // Nothing in that file named the studied side, so the shipped pair decides it.
      learningLanguage: 'en'
    })
  })

  it('reads the studied side out of a file written before the field existed', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 3,
      records: [
        {
          id: 'old-understand',
          sourceText: 'I was going to go.',
          targetText: '我本来打算去。',
          tone: 'natural',
          sourceLanguage: 'en',
          targetLanguage: 'zh',
          items: [],
          savedAt: 7
        }
      ]
    })

    expect(LanguageStore.open(file).list()[0]?.learningLanguage).toBe('en')
  })

  it('keeps the bare points of the oldest file, one sentence each', () => {
    const file = tempFile()
    writeLegacy(file, {
      version: 1,
      items: [
        { id: 'old-1', kind: 'vocabulary', expression: 'a bit too absolute', meaning: '有点太绝对', tone: 'casual', savedAt: 5 },
        { id: 'old-2', kind: 'expression', expression: 'come up', meaning: '临时有事', tone: 'casual', savedAt: 6 }
      ]
    })

    const listed = LanguageStore.open(file).list()
    // Two points with no sentence around them stay two moments: folding them together would
    // invent a sentence the user never saw.
    expect(listed).toHaveLength(2)
    expect(listed.map((sentence) => sentence.originalText)).toEqual(['', ''])
    expect(listed.map((sentence) => sentence.tone)).toEqual(['casual', 'casual'])
    expect(listed.map((sentence) => expressions(sentence.knowledgePoints))).toEqual([
      ['come up'],
      ['a bit too absolute']
    ])
    expect(listed[0]?.knowledgePoints[0]).toMatchObject({
      kind: 'expression',
      meaning: '临时有事',
      why: '',
      example: '',
      // The field is younger than the file, so a point from before it reads back empty.
      exampleTranslation: ''
    })
  })

  it('leaves a file it cannot recognise exactly as it was', () => {
    const file = tempFile()
    writeLegacy(file, { version: 4, records: [{ nothing: 'readable' }] })
    const originalBytes = readFileSync(file, 'utf8')

    expect(LanguageStore.open(file).list()).toEqual([])
    // Nothing to migrate means nothing is written: no backup, no rewrite.
    expect(readFileSync(file, 'utf8')).toBe(originalBytes)
    expect(() => readFileSync(file + '.v4.bak', 'utf8')).toThrow()
  })

  it('migrates into a file the new code can reopen', () => {
    const file = tempFile()
    writeLegacy(file, splitSentence)

    LanguageStore.open(file)
    const reopened = LanguageStore.open(file).list()

    expect(reopened).toHaveLength(1)
    expect(expressions(reopened[0]?.knowledgePoints ?? [])).toEqual(['turn out', 'did not expect'])
  })
})

/*
 * ---------------------------------------------------------------------------------------------
 * Studying a sentence: what Learn writes that Save did not.
 * ---------------------------------------------------------------------------------------------
 */

/** A sentence as a file written before the study fields existed holds it. */
function shapeSentence(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    nativeLanguage: 'zh',
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    originalText: '原文 ' + String(id),
    translatedText: 'translated ' + String(id),
    tone: 'natural',
    createdAt: '2026-09-24T00:00:00.000Z',
    savedAt: '2026-09-24T00:00:00.000Z',
    knowledgePoints: [],
    ...over
  }
}

/** One relation's shelf on disk, at the version asked for, with a counter that matches it. */
function writeShape(file: string, version: number, records: Record<string, unknown>[]): void {
  const highest = records.reduce((top, record) => Math.max(top, Number(record.id) || 0), 0)
  writeLegacy(file, {
    version,
    languages: { zh: { en: { nextId: highest + 1, records } } }
  })
}

function shelf(file: string, version: number): { nextId: number; records: SavedSentence[] } {
  const onDisk = stored(file)
  expect(onDisk.version).toBe(version)
  return onDisk.languages?.zh?.en as { nextId: number; records: SavedSentence[] }
}

describe('LanguageStore: studying a sentence', () => {
  it('counts a sentence as studied once when Learn writes it', () => {
    const store = LanguageStore.open(tempFile())
    const studied = store.learn(draft())

    // Learn hands back the record it filed, which is the receipt the panel shows.
    expect(store.list()).toHaveLength(1)
    expect(store.list()[0]?.id).toBe(studied.id)
    expect(studied.studyCount).toBe(1)
    expect(studied.lastReviewedAt).toBe(studied.savedAt)
    // Nothing is graded: Learn is a study pass, not a test.
    expect(studied.masteryScore).toBe(0)
  })

  it('counts a second pass over the same words, on the same record', () => {
    const store = LanguageStore.open(tempFile())
    store.learn(draft())
    const studied = store.learn(draft({ knowledgePoints: [point('ahead of time')] }))

    expect(store.list()).toHaveLength(1)
    expect(studied.id).toBe(1)
    expect(studied.studyCount).toBe(2)
    expect(studied.lastReviewedAt).toBe(studied.savedAt)
    // A second pass adds what it found; it never replaces what was already worth learning.
    expect(expressions(studied.knowledgePoints)).toEqual(['pretty interesting', 'ahead of time'])
  })

  it('leaves the sentence Save still writes looking unstudied', () => {
    const listed = LanguageStore.open(tempFile()).save(draft())

    // Save is "keep this", not "study this": the record exists but has not been learned from.
    expect(listed[0]?.studyCount).toBe(0)
    expect(listed[0]?.lastReviewedAt).toBeNull()
  })

  it('does not let a study pass overwrite a score a review already set', () => {
    const file = tempFile()
    writeShape(file, 7, [shapeSentence(1, { savedAt: '2026-09-24T00:00:00.000Z', studyCount: 3, lastReviewedAt: '2026-09-20T00:00:00.000Z', masteryScore: 60 })])
    const studied = LanguageStore.open(file).learn(
      draft({ originalText: '原文 1', translatedText: 'translated 1' })
    )

    expect(studied.masteryScore).toBe(60)
    expect(studied.studyCount).toBe(4)
  })

  it('reads the study fields a file written before them never had', () => {
    const file = tempFile()
    writeShape(file, 6, [
      shapeSentence(1, { knowledgePoints: [{ kind: 'expression', expression: 'turn out', meaning: '结果是' }] }),
      shapeSentence(2)
    ])

    const listed = LanguageStore.open(file).list()
    const withPoints = listed.find((sentence) => sentence.id === 1)
    const withoutPoints = listed.find((sentence) => sentence.id === 2)

    // The points are the evidence: they could only have come from a study pass.
    expect(withPoints?.studyCount).toBe(1)
    expect(withPoints?.lastReviewedAt).toBe(withPoints?.savedAt)
    expect(withPoints?.masteryScore).toBe(0)
    expect(withoutPoints?.studyCount).toBe(0)
    expect(withoutPoints?.lastReviewedAt).toBe(withoutPoints?.savedAt)
  })

  it('reads an unusable score as the default and a null review time as never', () => {
    const file = tempFile()
    writeShape(file, 7, [
      shapeSentence(1, { masteryScore: 999, lastReviewedAt: null }),
      shapeSentence(2, { masteryScore: -5 }),
      shapeSentence(3, { masteryScore: 'high', lastReviewedAt: 'not a time' })
    ])

    const listed = LanguageStore.open(file).list()
    const [first, second, third] = [1, 2, 3].map((id) => listed.find((sentence) => sentence.id === id))

    expect(first?.masteryScore).toBe(100)
    expect(first?.lastReviewedAt).toBeNull()
    expect(second?.masteryScore).toBe(0)
    // An unreadable review time is the time the sentence was kept, not the epoch.
    expect(third?.masteryScore).toBe(0)
    expect(third?.lastReviewedAt).toBe(third?.savedAt)
  })

  it('leaves a file of the older shape exactly as it was until something is written', () => {
    const file = tempFile()
    writeShape(file, 6, [shapeSentence(1)])
    const originalBytes = readFileSync(file, 'utf8')

    LanguageStore.open(file)
    LanguageStore.open(file).list()

    // Only the fields are missing, and those read with their defaults: opening writes nothing,
    // and nothing is copied aside either.
    expect(readFileSync(file, 'utf8')).toBe(originalBytes)
    expect(() => readFileSync(file + '.v6.bak', 'utf8')).toThrow()
  })

  it('brings that file up to date behind a .v6.bak on the first real write', () => {
    const file = tempFile()
    writeShape(file, 6, [shapeSentence(1, { id: 1 })])
    const originalBytes = readFileSync(file, 'utf8')
    const store = LanguageStore.open(file)

    const studied = store.learn(draft({ originalText: '原文 1', translatedText: 'translated 1' }))

    expect(store.list()).toHaveLength(1)
    expect(studied.studyCount).toBe(1)
    expect(shelf(file, 7).nextId).toBe(2)
    // The copy is the file as it really was, so the bytes the user had are never lost.
    expect(readFileSync(file + '.v6.bak', 'utf8')).toBe(originalBytes)
  })

  it('does not copy a file aside again once it is current', () => {
    const file = tempFile()
    const store = LanguageStore.open(file)
    store.learn(draft())
    store.learn(draft({ knowledgePoints: [point('ahead of time')] }))

    expect(shelf(file, 7).nextId).toBe(2)
    expect(() => readFileSync(file + '.v7.bak', 'utf8')).toThrow()
    expect(() => readFileSync(file + '.v6.bak', 'utf8')).toThrow()
  })

  it('keeps ids and the counter of an older file while learning into it', () => {
    const file = tempFile()
    writeShape(file, 6, [shapeSentence(5)])
    const store = LanguageStore.open(file)
    store.learn(draft({ originalText: '新的一句', translatedText: 'A new one.' }))
    const listed = store.list()

    // The existing sentence keeps its number, and the new one carries on from the counter.
    expect(listed.map((sentence) => sentence.id).sort((left, right) => left - right)).toEqual([5, 6])
    expect(shelf(file, 7).nextId).toBe(7)
  })
})
