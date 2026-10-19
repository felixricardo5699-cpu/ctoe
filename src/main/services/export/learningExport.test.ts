import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExportDocument } from '@shared/learning/exportDocument'
import { writeDocuments } from './learningExport'

const NOW = new Date('2026-10-19T08:00:00.000Z')

let workdir: string | null = null

afterEach(() => {
  if (workdir !== null) rmSync(workdir, { recursive: true, force: true })
  workdir = null
})

function document(fileName: string): ExportDocument {
  return {
    fileName,
    title: 'My Learning · Chinese → English',
    intro: ['说明'],
    blocks: [{ kind: 'heading', level: 1, text: '句子' }]
  }
}

describe('learning export: writing files', () => {
  it('creates the folder and writes one document per relation', () => {
    workdir = mkdtempSync(join(tmpdir(), 'ctoe-export-'))
    const folder = join(workdir, 'nested', 'ctoe 学习记录')

    const written = writeDocuments(
      folder,
      [document('Chinese_English.docx'), document('English_Chinese.docx')],
      NOW
    )

    // The default export folder does not exist on a fresh install, so it has to be created.
    expect(readdirSync(folder).sort()).toEqual(['Chinese_English.docx', 'English_Chinese.docx'])
    expect(written).toHaveLength(2)
  })

  it('writes real zip packages, not empty placeholders', () => {
    workdir = mkdtempSync(join(tmpdir(), 'ctoe-export-'))
    const folder = join(workdir, 'export')

    const [file] = writeDocuments(folder, [document('Chinese_English.docx')], NOW)

    const bytes = readFileSync(file as string)
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(bytes.readUInt32LE(0)).toBe(0x04034b50)
    expect(bytes.length).toBeGreaterThan(1000)
  })

  it('replaces a previous export instead of piling up copies', () => {
    workdir = mkdtempSync(join(tmpdir(), 'ctoe-export-'))
    const folder = join(workdir, 'export')

    writeDocuments(folder, [document('Chinese_English.docx')], NOW)
    writeDocuments(folder, [document('Chinese_English.docx')], NOW)

    expect(readdirSync(folder)).toEqual(['Chinese_English.docx'])
  })
})
