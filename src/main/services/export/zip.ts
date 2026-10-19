import { deflateRawSync } from 'node:zlib'

/*
 * The smallest ZIP writer that an Office file needs.
 *
 * A .docx is an OPC package: a ZIP holding XML parts. There is no ZIP writer in Node's standard
 * library, and pulling in a dependency for one export would be the largest thing in this app for
 * the least code - so the handful of structures the format actually requires are written here:
 * local file headers, a central directory, and an end-of-central-directory record.
 *
 * Everything is deflated (method 8) and every name is flagged UTF-8 (bit 11), which is what Word,
 * WPS, LibreOffice and Google Docs all accept. What is deliberately missing is the rest of the
 * format: no ZIP64, no encryption, no data descriptors, no directory entries. A learning export is
 * a handful of small XML parts, so none of them can matter, and leaving them out keeps this file
 * readable.
 */

export interface ZipEntry {
  /** Path inside the archive, with forward slashes, e.g. `word/document.xml`. */
  name: string
  data: Buffer
}

/** Local file header signature, then its fixed part before the name. */
const LOCAL_HEADER_SIZE = 30
/** Central directory record signature, then its fixed part before the name. */
const CENTRAL_HEADER_SIZE = 46
/** End-of-central-directory record: signature plus the fields Word requires. */
const END_RECORD_SIZE = 22

/** Bit 11: the name is UTF-8. Set for every entry, so non-ASCII names stay readable. */
const FLAG_UTF8 = 0x0800
/** Compression method 8 = deflate. */
const METHOD_DEFLATE = 8

export function buildZip(entries: readonly ZipEntry[], modifiedAt: Date): Buffer {
  const { time, date } = dosTimestamp(modifiedAt)
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const deflated = deflateRawSync(entry.data, { level: 9 })
    const crc = crc32(entry.data)

    const header = Buffer.alloc(LOCAL_HEADER_SIZE)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4) // version needed to extract
    header.writeUInt16LE(FLAG_UTF8, 6)
    header.writeUInt16LE(METHOD_DEFLATE, 8)
    header.writeUInt16LE(time, 10)
    header.writeUInt16LE(date, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(deflated.length, 18)
    header.writeUInt32LE(entry.data.length, 22)
    header.writeUInt16LE(name.length, 26)
    header.writeUInt16LE(0, 28) // no extra field
    local.push(header, name, deflated)

    const record = Buffer.alloc(CENTRAL_HEADER_SIZE)
    record.writeUInt32LE(0x02014b50, 0)
    record.writeUInt16LE(20, 4) // version made by (2.0)
    record.writeUInt16LE(20, 6) // version needed
    record.writeUInt16LE(FLAG_UTF8, 8)
    record.writeUInt16LE(METHOD_DEFLATE, 10)
    record.writeUInt16LE(time, 12)
    record.writeUInt16LE(date, 14)
    record.writeUInt32LE(crc, 16)
    record.writeUInt32LE(deflated.length, 20)
    record.writeUInt32LE(entry.data.length, 24)
    record.writeUInt16LE(name.length, 28)
    record.writeUInt16LE(0, 30) // no extra field
    record.writeUInt16LE(0, 32) // no comment
    record.writeUInt16LE(0, 34) // first disk
    record.writeUInt16LE(0, 36) // internal attributes
    record.writeUInt32LE(0, 38) // external attributes
    record.writeUInt32LE(offset, 42)
    central.push(record, name)

    offset += header.length + name.length + deflated.length
  }

  const directory = Buffer.concat(central)
  const end = Buffer.alloc(END_RECORD_SIZE)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4) // this disk
  end.writeUInt16LE(0, 6) // disk with the directory
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20) // no comment

  return Buffer.concat([...local, directory, end])
}

/** MS-DOS date and time, which is what the ZIP headers carry (local time, two-second steps). */
function dosTimestamp(when: Date): { time: number; date: number } {
  const year = Math.max(1980, when.getFullYear())
  return {
    time:
      ((when.getHours() & 0x1f) << 11) |
      ((when.getMinutes() & 0x3f) << 5) |
      ((when.getSeconds() >> 1) & 0x1f),
    date: (((year - 1980) & 0x7f) << 9) | (((when.getMonth() + 1) & 0x0f) << 5) | (when.getDate() & 0x1f)
  }
}

/** The standard CRC-32 (IEEE 802.3) the ZIP format stores for each entry. */
const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
