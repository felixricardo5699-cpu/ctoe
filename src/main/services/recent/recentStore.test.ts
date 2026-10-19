import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FALLBACK_TIME_ISO } from '@shared/language/time'
import { RECENT_TRANSLATION_LIMIT } from '@shared/types'
import { RECENT_VERSION, RecentStore, type RecentTranslationDraft } from './recentStore'

// Only the default path uses Electron; every test here passes an explicit file.
vi.mock('electron', () => ({ app: { getPath: () => 'test-user-data' } }))

const dirs: string[] = []

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctoe-recent-'))
  dirs.push(dir)
  return join(dir, 'recent.json')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One translation as the main process would hand it over: written, with the studied side named. */
function draft(overrides: Partial<RecentTranslationDraft> = {}): RecentTranslationDraft {
  return {
    sourceLanguage: 'zh',
    targetLanguage: 'en',
    learningLanguage: 'en',
    tone: 'natural',
    sourceText: '我本来想去',
    targetText: 'I was going to go.',
    ...overrides
  }
}

function readFile(file: string): { version: number; entries: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(file, 'utf8')) as {
    version: number
    entries: Array<Record<string, unknown>>
  }
}

describe('RecentStore: reading', () => {
  it('starts empty when there is no file yet, and does not create one just by opening', () => {
    const file = tempFile()

    expect(RecentStore.open(file).list()).toEqual([])
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })

  it('reads a file back after a restart, newest first', () => {
    const file = tempFile()
    const store = RecentStore.open(file)
    store.record(draft({ sourceText: 'first', targetText: '1' }))
    store.record(draft({ sourceText: 'second', targetText: '2' }))

    const reopened = RecentStore.open(file)
    expect(reopened.list().map((row) => row.sourceText)).toEqual(['second', 'first'])
  })

  it('reads a corrupt file as empty instead of throwing it at the user', () => {
    const file = tempFile()
    writeFileSync(file, '{ not json at all', 'utf8')

    expect(RecentStore.open(file).list()).toEqual([])
  })

  it('drops rows that are not usable translations and keeps the rest', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        version: RECENT_VERSION,
        entries: [
          { id: 'a', sourceLanguage: 'zh', targetLanguage: 'en', sourceText: 'ok', targetText: 'fine', createdAt: '2026-09-24T10:00:00.000Z' },
          { id: '', sourceLanguage: 'zh', targetLanguage: 'en', sourceText: 'no id', targetText: 'x' },
          { id: 'c', sourceLanguage: 'zh', targetLanguage: 'zh', sourceText: 'same both sides', targetText: 'x' },
          { id: 'd', sourceLanguage: 'klingon', targetLanguage: 'en', sourceText: 'unknown code', targetText: 'x' },
          { id: 'e', sourceLanguage: 'zh', targetLanguage: 'en', sourceText: 7, targetText: 'not a string' },
          { id: 'f', sourceLanguage: 'zh', targetLanguage: 'en', sourceText: '', targetText: '' },
          'not even an object'
        ]
      }),
      'utf8'
    )

    expect(RecentStore.open(file).list().map((row) => row.id)).toEqual(['a'])
  })

  it('keeps a row written before the studied side existed, and says nothing it does not know', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        version: RECENT_VERSION,
        entries: [
          { id: 'old', sourceLanguage: 'zh', targetLanguage: 'en', sourceText: '旧的', targetText: 'old', createdAt: '2026-09-24T10:00:00.000Z' }
        ]
      }),
      'utf8'
    )

    // The row keeps its place - it is still a translation the user made - but without a studied
    // side it is not learnable, which the reader expresses by simply not claiming one.
    const row = RecentStore.open(file).list()[0]
    expect(row?.sourceText).toBe('旧的')
    expect(row?.learningLanguage).toBeUndefined()
    expect(row?.tone).toBe('natural')
  })

  it('ignores a studied side or tone that could not have been written', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        version: RECENT_VERSION,
        entries: [
          { id: 'junk', sourceLanguage: 'zh', targetLanguage: 'en', learningLanguage: 'klingon', tone: 'shouting', sourceText: 'a', targetText: 'b' }
        ]
      }),
      'utf8'
    )

    const row = RecentStore.open(file).list()[0]
    expect(row?.learningLanguage).toBeUndefined()
    expect(row?.tone).toBe('natural')
  })

  it('reads an unreadable time as the epoch, so a damaged row cannot look newest', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        version: RECENT_VERSION,
        entries: [
          { id: 'broken', sourceLanguage: 'zh', targetLanguage: 'en', sourceText: 'broken', targetText: 'x', createdAt: 'not a time' },
          { id: 'real', sourceLanguage: 'zh', targetLanguage: 'en', sourceText: 'real', targetText: 'y', createdAt: '2026-09-24T10:00:00.000Z' }
        ]
      }),
      'utf8'
    )

    const rows = RecentStore.open(file).list()
    expect(rows[0]?.id).toBe('real')
    expect(rows[1]?.createdAt).toBe(FALLBACK_TIME_ISO)
  })
})

describe('RecentStore: recording', () => {
  it('stamps the file with its version and keeps the pair as the moment\u2019s own', () => {
    const file = tempFile()

    RecentStore.open(file).record(draft({ sourceLanguage: 'en', targetLanguage: 'ar' }))

    const written = readFile(file)
    expect(written.version).toBe(RECENT_VERSION)
    expect(written.entries).toHaveLength(1)
    expect(written.entries[0]?.sourceLanguage).toBe('en')
    expect(written.entries[0]?.targetLanguage).toBe('ar')
    expect(typeof written.entries[0]?.createdAt).toBe('string')
    // The studied side and the register travel with the row: they are what a later Learn needs
    // to coach this sentence the same way, whatever the settings say by then.
    expect(written.entries[0]?.learningLanguage).toBe('en')
    expect(written.entries[0]?.tone).toBe('natural')
  })

  it('moves a translation it already holds to the top instead of storing it twice', () => {
    const store = RecentStore.open(tempFile())
    store.record(draft({ sourceText: 'a', targetText: 'A' }))
    store.record(draft({ sourceText: 'b', targetText: 'B' }))
    store.record(draft({ sourceText: 'a', targetText: 'A' }))

    expect(store.list().map((row) => row.sourceText)).toEqual(['a', 'b'])
  })

  it('keeps a different answer for the same input as its own row', () => {
    const store = RecentStore.open(tempFile())
    store.record(draft({ sourceText: '我本来想去', targetText: 'I was going to go.' }))
    store.record(draft({ sourceText: '我本来想去', targetText: 'I meant to go.' }))

    expect(store.list()).toHaveLength(2)
  })

  it('keeps the two directions of one pair apart, because they are different moments', () => {
    const store = RecentStore.open(tempFile())
    store.record(draft({ sourceLanguage: 'zh', targetLanguage: 'en', sourceText: 's', targetText: 't' }))
    store.record(draft({ sourceLanguage: 'en', targetLanguage: 'zh', sourceText: 's', targetText: 't' }))

    expect(store.list()).toHaveLength(2)
  })

  it('drops the oldest row once the list is full', () => {
    const store = RecentStore.open(tempFile())
    for (let index = 0; index < RECENT_TRANSLATION_LIMIT + 5; index += 1) {
      store.record(draft({ sourceText: 'text ' + String(index), targetText: 'out ' + String(index) }))
    }

    const rows = store.list()
    expect(rows).toHaveLength(RECENT_TRANSLATION_LIMIT)
    expect(rows[0]?.sourceText).toBe('text ' + String(RECENT_TRANSLATION_LIMIT + 4))
    expect(rows.some((row) => row.sourceText === 'text 0')).toBe(false)
  })

  it('does not read past the cap either, so a hand-edited file cannot grow it', () => {
    const file = tempFile()
    const entries = Array.from({ length: RECENT_TRANSLATION_LIMIT + 10 }, (_value, index) => ({
      id: 'id-' + String(index),
      sourceLanguage: 'zh',
      targetLanguage: 'en',
      sourceText: 'text ' + String(index),
      targetText: 'out ' + String(index),
      createdAt: new Date(Date.UTC(2026, 8, 24, 0, index)).toISOString()
    }))
    writeFileSync(file, JSON.stringify({ version: RECENT_VERSION, entries }), 'utf8')

    const rows = RecentStore.open(file).list()
    expect(rows).toHaveLength(RECENT_TRANSLATION_LIMIT)
    // Newest first, so the highest minute is the one that survived.
    expect(rows[0]?.sourceText).toBe('text ' + String(RECENT_TRANSLATION_LIMIT + 9))
  })
})

describe('RecentStore: clearing', () => {
  it('empties the list for good, and a reopen still reads an empty list', () => {
    const file = tempFile()
    const store = RecentStore.open(file)
    store.record(draft())

    expect(store.clear()).toEqual([])
    expect(RecentStore.open(file).list()).toEqual([])
    expect(readFile(file).entries).toEqual([])
  })

  it('leaves the file alone when there was nothing to clear', () => {
    const file = tempFile()

    expect(RecentStore.open(file).clear()).toEqual([])
    expect(() => readFileSync(file, 'utf8')).toThrow()
  })
})
