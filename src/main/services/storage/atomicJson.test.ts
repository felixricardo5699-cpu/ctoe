import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { backupFile, toJsonText, writeJsonAtomic } from './atomicJson'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ctoe-atomic-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeJsonAtomic', () => {
  it('writes the JSON text, with a trailing newline', () => {
    const file = join(tempDir(), 'learned.json')

    writeJsonAtomic(file, { version: 5, languages: {} })

    expect(readFileSync(file, 'utf8')).toBe(toJsonText({ version: 5, languages: {} }))
    expect(readFileSync(file, 'utf8').endsWith('\n')).toBe(true)
  })

  it('creates the directory it writes into', () => {
    const file = join(tempDir(), 'nested', 'deeper', 'learned.json')

    writeJsonAtomic(file, { ok: true })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ok: true })
  })

  it('leaves no temp file behind', () => {
    const dir = tempDir()
    const file = join(dir, 'learned.json')

    writeJsonAtomic(file, { a: 1 })
    writeJsonAtomic(file, { a: 2 })

    expect(readdirSync(dir)).toEqual(['learned.json'])
  })

  it('replaces the old file in one step, so a reader never sees half of one', () => {
    const file = join(tempDir(), 'learned.json')
    writeJsonAtomic(file, { round: 1 })

    writeJsonAtomic(file, { round: 2 })

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ round: 2 })
    expect(readdirSync(join(file, '..'))).toHaveLength(1)
  })

  it('leaves the file that was already there untouched when a write fails', () => {
    const dir = tempDir()
    const file = join(dir, 'learned.json')
    writeJsonAtomic(file, { round: 1 })
    const before = readFileSync(file, 'utf8')
    const circular: Record<string, unknown> = {}
    circular.self = circular

    // A value that cannot be serialized is how a write fails in practice - a circular
    // structure, a BigInt, a disk that stopped accepting bytes at the wrong moment.
    expect(() => writeJsonAtomic(file, circular)).toThrow()

    // The old file is still the one on disk, and no half-written temp file is left beside it.
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(readdirSync(dir)).toEqual(['learned.json'])
  })
})

describe('backupFile', () => {
  it('copies the file aside and says so', () => {
    const dir = tempDir()
    const file = join(dir, 'learned.json')
    const backup = file + '.v4.bak'
    writeFileSync(file, '{"version":4}', 'utf8')

    expect(backupFile(file, backup)).toBe(true)
    expect(readFileSync(backup, 'utf8')).toBe('{"version":4}')
    // The original is still there: a backup copies, it does not move.
    expect(readFileSync(file, 'utf8')).toBe('{"version":4}')
  })

  it('refuses to overwrite a backup that already exists', () => {
    const dir = tempDir()
    const file = join(dir, 'learned.json')
    const backup = file + '.v4.bak'
    writeFileSync(file, '{"version":4}', 'utf8')
    backupFile(file, backup)
    // The upgrade rewrote the file; the backup must still hold the original bytes.
    writeFileSync(file, '{"version":5}', 'utf8')

    expect(backupFile(file, backup)).toBe(false)
    expect(readFileSync(backup, 'utf8')).toBe('{"version":4}')
  })

  it('does nothing when there is no file to keep', () => {
    const dir = tempDir()
    expect(backupFile(join(dir, 'missing.json'), join(dir, 'missing.json.bak'))).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
