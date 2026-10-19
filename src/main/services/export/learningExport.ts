import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ExportDocument } from '@shared/learning/exportDocument'
import { buildDocx } from './docx'

/**
 * Writes the prepared documents into a folder, one `.docx` per language relation.
 *
 * Kept apart from Electron on purpose: this is the part that touches the disk, so a test can point
 * it at a temporary directory and read back what a user would get. The folder is created when it
 * does not exist yet - the default export folder usually does not on a fresh install.
 */
export function writeDocuments(
  folder: string,
  documents: readonly ExportDocument[],
  now: Date
): string[] {
  mkdirSync(folder, { recursive: true })
  const written: string[] = []
  for (const document of documents) {
    const target = join(folder, document.fileName)
    writeFileSync(target, buildDocx(document, now))
    written.push(target)
  }
  return written
}
