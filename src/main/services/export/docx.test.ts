import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import type { ExportDocument } from '@shared/learning/exportDocument'
import { buildDocx } from './docx'

const NOW = new Date('2026-10-19T08:00:00.000Z')

function sample(overrides: Partial<ExportDocument> = {}): ExportDocument {
  return {
    fileName: 'Chinese_English.docx',
    title: 'My Learning · Chinese → English',
    intro: ['第一行说明。', '导出日期 2026-10-19 · 共 1 句 · 1 个学习点'],
    blocks: [
      { kind: 'heading', level: 1, text: '句子' },
      { kind: 'heading', level: 2, text: '#000001 · Say it · 2026-10-01 · natural' },
      { kind: 'paragraph', text: '原文：我觉得这个想法挺有意思。' },
      { kind: 'paragraph', text: '译文：I think this idea is pretty interesting.' },
      {
        kind: 'table',
        headers: ['类型', '表达', '意思'],
        rows: [['表达', 'come up', '临时有事']]
      }
    ],
    ...overrides
  }
}

/**
 * A ZIP reader small enough to trust: it walks the local headers we wrote, which is exactly how a
 * consumer that does not use the central directory reads a package. If the layout were wrong, the
 * offsets here would not line up.
 */
function readEntries(zip: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>()
  let offset = 0
  while (offset + 30 <= zip.length && zip.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = zip.readUInt32LE(offset + 18)
    const nameLength = zip.readUInt16LE(offset + 26)
    const extraLength = zip.readUInt16LE(offset + 28)
    const name = zip.subarray(offset + 30, offset + 30 + nameLength).toString('utf8')
    const start = offset + 30 + nameLength + extraLength
    entries.set(name, inflateRawSync(zip.subarray(start, start + compressedSize)))
    offset = start + compressedSize
  }
  return entries
}

function part(document: ExportDocument, name: string): string {
  return readEntries(buildDocx(document, NOW)).get(name)?.toString('utf8') ?? ''
}

describe('docx: the package Word opens', () => {
  it('is a zip with every part a WordprocessingML package needs', () => {
    const zip = buildDocx(sample(), NOW)

    // A local file header at the front and an end-of-central-directory record at the back.
    expect(zip.readUInt32LE(0)).toBe(0x04034b50)
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50)

    expect([...readEntries(zip).keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/app.xml',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/styles.xml'
    ])
  })

  it('writes the title, the intro and every block into the body', () => {
    const xml = part(sample(), 'word/document.xml')

    expect(xml).toContain('My Learning · Chinese → English')
    expect(xml).toContain('第一行说明。')
    expect(xml).toContain('w:pStyle w:val="Title"')
    expect(xml).toContain('w:pStyle w:val="Heading1"')
    expect(xml).toContain('w:pStyle w:val="Heading2"')
    expect(xml).toContain('#000001 · Say it · 2026-10-01 · natural')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('come up')
    // A4, portrait: the section properties are what makes the print button produce a page.
    expect(xml).toContain('<w:pgSz w:w="11906" w:h="16838"/>')
  })

  it('repeats the table header row across pages', () => {
    const xml = part(sample(), 'word/document.xml')

    expect(xml).toContain('<w:tblHeader/>')
  })

  it('escapes XML and drops the characters XML cannot carry at all', () => {
    const xml = part(
      sample({ blocks: [{ kind: 'paragraph', text: 'a < b & c "d"\u0001\u0008 done' }] }),
      'word/document.xml'
    )

    expect(xml).toContain('a &lt; b &amp; c &quot;d&quot;')
    expect(xml).toContain('done')
    expect(xml).not.toContain('\u0001')
    expect(xml).not.toContain('\u0008')
  })

  it('names a CJK font, so a Chinese sentence does not print as boxes', () => {
    const styles = part(sample(), 'word/styles.xml')

    expect(styles).toContain('w:eastAsia="宋体"')
    expect(styles).toContain('styleId="Heading1"')
    expect(styles).toContain('styleId="Heading2"')
  })

  it('stamps the file properties with a title and a date', () => {
    const core = part(sample(), 'docProps/core.xml')

    expect(core).toContain('<dc:title>My Learning · Chinese → English</dc:title>')
    expect(core).toContain('2026-10-19T08:00:00Z')
    expect(part(sample(), 'docProps/app.xml')).toContain('<Application>ctoe</Application>')
  })

  it('keeps a line break inside a paragraph as a real break', () => {
    const xml = part(
      sample({ blocks: [{ kind: 'paragraph', text: 'first\nsecond' }] }),
      'word/document.xml'
    )

    expect(xml).toContain('first</w:t></w:r><w:br/><w:r><w:t xml:space="preserve">second')
  })
})
