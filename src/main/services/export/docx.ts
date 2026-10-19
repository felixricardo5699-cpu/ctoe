import type { ExportBlock, ExportDocument } from '@shared/learning/exportDocument'
import { buildZip, type ZipEntry } from './zip'

/*
 * A neutral document description -> a real .docx.
 *
 * Only the parts of WordprocessingML this export actually uses are emitted: paragraphs in four
 * styles (Normal, Title, Heading 1, Heading 2) and tables with a repeating header row. Nothing
 * else is claimed - no numbering, no fields, no comments - because every feature added here is one
 * more thing Word, WPS and LibreOffice can disagree about.
 *
 * A4 portrait, 2cm margins, Calibri for Latin text and 宋体 for CJK: a Chinese sentence printed
 * next to an English one has to look right on paper, and Word picks the CJK font from
 * `w:eastAsia`, which is the reason the style block exists at all.
 */

/** A4 width in twips (210mm). */
const PAGE_WIDTH = 11906
/** A4 height in twips (297mm). */
const PAGE_HEIGHT = 16838
/** 2cm margins in twips. */
const MARGIN = 1134
/** Usable width, which is what a table has to fit into. */
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2

/** 11pt body text, 9pt table text, all in half-points as the format wants. */
const BODY_HALF_POINTS = 22
const TABLE_HALF_POINTS = 18
const INTRO_HALF_POINTS = 18

export function buildDocx(document: ExportDocument, now: Date): Buffer {
  const parts: ZipEntry[] = [
    { name: '[Content_Types].xml', data: text(contentTypes()) },
    { name: '_rels/.rels', data: text(packageRelationships()) },
    { name: 'docProps/core.xml', data: text(coreProperties(document.title, now)) },
    { name: 'docProps/app.xml', data: text(appProperties()) },
    { name: 'word/document.xml', data: text(documentXml(document)) },
    { name: 'word/_rels/document.xml.rels', data: text(documentRelationships()) },
    { name: 'word/styles.xml', data: text(stylesXml()) }
  ]
  return buildZip(parts, now)
}

function text(value: string): Buffer {
  return Buffer.from(value, 'utf8')
}

// ---------------------------------------------------------------- document body

function documentXml(document: ExportDocument): string {
  const body = [
    paragraph(document.title, { style: 'Title' }),
    ...document.intro.map((line) => paragraph(line, { size: INTRO_HALF_POINTS, color: '6B7280' })),
    ...document.blocks.map(blockXml),
    // Word wants a paragraph after a table that ends the body, or the last row can be clipped.
    emptyParagraph()
  ].join('')

  return header() +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + body +
    '<w:sectPr><w:pgSz w:w="' + PAGE_WIDTH + '" w:h="' + PAGE_HEIGHT + '"/>' +
    '<w:pgMar w:top="' + MARGIN + '" w:right="' + MARGIN + '" w:bottom="' + MARGIN +
    '" w:left="' + MARGIN + '" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>'
}

function blockXml(block: ExportBlock): string {
  if (block.kind === 'heading') {
    return paragraph(block.text, { style: block.level === 1 ? 'Heading1' : 'Heading2' })
  }
  if (block.kind === 'paragraph') return paragraph(block.text)
  return tableXml(block.headers, block.rows)
}

// ---------------------------------------------------------------- paragraphs

interface ParagraphStyle {
  style?: 'Normal' | 'Title' | 'Heading1' | 'Heading2'
  size?: number
  color?: string
}

function paragraph(value: string, style: ParagraphStyle = {}): string {
  const properties = '<w:pPr><w:pStyle w:val="' + (style.style ?? 'Normal') + '"/></w:pPr>'
  // A stored line break becomes a real break, so nothing that survived storage is flattened.
  const runs = value
    .split('\n')
    .map((line, index) => (index === 0 ? '' : '<w:br/>') + run(line, style))
    .join('')
  return '<w:p>' + properties + runs + '</w:p>'
}

function emptyParagraph(): string {
  return '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
}

function run(value: string, style: ParagraphStyle): string {
  const properties: string[] = []
  if (style.size !== undefined) {
    properties.push('<w:sz w:val="' + style.size + '"/><w:szCs w:val="' + style.size + '"/>')
  }
  if (style.color !== undefined) properties.push('<w:color w:val="' + style.color + '"/>')
  const rPr = properties.length === 0 ? '' : '<w:rPr>' + properties.join('') + '</w:rPr>'
  return '<w:r>' + rPr + '<w:t xml:space="preserve">' + escapeXml(value) + '</w:t></w:r>'
}

// ---------------------------------------------------------------- tables

const BORDER =
  '<w:top w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
  '<w:left w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
  '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
  '<w:right w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
  '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>' +
  '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="D1D5DB"/>'

function tableXml(headers: readonly string[], rows: readonly string[][]): string {
  const columns = Math.max(1, headers.length)
  const columnWidth = Math.floor(CONTENT_WIDTH / columns)
  const grid = headers.map(() => '<w:gridCol w:w="' + columnWidth + '"/>').join('')
  const head = '<w:tr><w:trPr><w:tblHeader/></w:trPr>' + rowCells(headers, columns, true) + '</w:tr>'
  const body = rows.map((row) => '<w:tr>' + rowCells(row, columns, false) + '</w:tr>').join('')

  return '<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>' +
    '<w:tblBorders>' + BORDER + '</w:tblBorders>' +
    '<w:tblLayout w:type="autofit"/>' +
    '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>' +
    '<w:bottom w:w="40" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tblCellMar>' +
    '</w:tblPr><w:tblGrid>' + grid + '</w:tblGrid>' + head + body + '</w:tbl>' +
    emptyParagraph()
}

function rowCells(values: readonly string[], columns: number, header: boolean): string {
  // A short row is padded rather than rejected: a malformed table is worse than an empty cell.
  const cells: string[] = []
  for (let column = 0; column < columns; column += 1) {
    cells.push(cellXml(values[column] ?? '', header))
  }
  return cells.join('')
}

/** A cell has one paragraph and takes its width from the grid, so Word does not re-flow it. */
function cellXml(value: string, header: boolean): string {
  const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''
  const bold = header ? '<w:b/>' : ''
  return '<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>' + shading +
    '<w:vAlign w:val="top"/></w:tcPr>' +
    '<w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>' +
    '<w:r><w:rPr>' + bold + '<w:sz w:val="' + TABLE_HALF_POINTS + '"/>' +
    '<w:szCs w:val="' + TABLE_HALF_POINTS + '"/></w:rPr>' +
    '<w:t xml:space="preserve">' + escapeXml(value) + '</w:t></w:r></w:p></w:tc>'
}

// ---------------------------------------------------------------- package parts

function header(): string {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
}

function contentTypes(): string {
  return header() +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
    '</Types>'
}

function packageRelationships(): string {
  return header() +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>'
}

function documentRelationships(): string {
  return header() +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>'
}

function coreProperties(title: string, now: Date): string {
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z')
  return header() +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"' +
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"' +
    ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:title>' + escapeXml(title) + '</dc:title>' +
    '<dc:creator>ctoe</dc:creator><cp:lastModifiedBy>ctoe</cp:lastModifiedBy>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + stamp + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + stamp + '</dcterms:modified>' +
    '</cp:coreProperties>'
}

function appProperties(): string {
  return header() +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>ctoe</Application></Properties>'
}

function stylesXml(): string {
  return header() +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr>' +
    '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="宋体" w:cs="Calibri"/>' +
    '<w:sz w:val="' + BODY_HALF_POINTS + '"/><w:szCs w:val="' + BODY_HALF_POINTS + '"/>' +
    '<w:lang w:val="en-US" w:eastAsia="zh-CN"/>' +
    '</w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
    '</w:docDefaults>' +
    style('Normal', 'Normal', '<w:qFormat/>') +
    style(
      'Title',
      'Title',
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
        '<w:pPr><w:spacing w:after="180"/></w:pPr>' +
        '<w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/><w:color w:val="111827"/></w:rPr>'
    ) +
    style(
      'Heading1',
      'heading 1',
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
        '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
        '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/><w:color w:val="1F2937"/></w:rPr>'
    ) +
    style(
      'Heading2',
      'heading 2',
      '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
        '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="60"/><w:outlineLvl w:val="1"/></w:pPr>' +
        '<w:rPr><w:b/><w:sz w:val="26"/><w:szCs w:val="26"/><w:color w:val="374151"/></w:rPr>'
    ) +
    '</w:styles>'
}

function style(id: string, name: string, body: string): string {
  return '<w:style w:type="paragraph" w:styleId="' + id + '"><w:name w:val="' + name + '"/>' +
    body + '</w:style>'
}

/**
 * XML text escaping, plus the control characters XML 1.0 cannot carry at all. A pasted sentence
 * may contain any of them; dropping them is better than producing a file Word refuses to open.
 */
function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export { escapeXml }
