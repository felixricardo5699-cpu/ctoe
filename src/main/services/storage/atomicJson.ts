import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/*
 * Writing the local files without ever leaving half of one behind.
 *
 * Both ways this could go wrong are real here: the app is closed by a user who does not wait
 * for it, and the file is rewritten on every Learn. A truncated learned.json would read as "your
 * notes are gone", so every write goes to a temp file in the same directory and is then renamed
 * over the target, which the filesystem does as one step.
 */

/** The JSON text both files are written as: two-space indented, newline-terminated. */
export function toJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n'
}

/**
 * Writes JSON atomically. The temp file is created next to the target rather than in the
 * system temp directory: a rename is only atomic inside one filesystem.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tempPath = filePath + '.' + randomUUID() + '.tmp'
  try {
    writeFileSync(tempPath, toJsonText(value), { encoding: 'utf8', mode: 0o600 })
    // Replaces the old file in one step, so a reader sees either the old file or the new one.
    renameSync(tempPath, filePath)
  } catch (error) {
    try {
      rmSync(tempPath, { force: true })
    } catch {
      // The temp file is already gone, or the disk is refusing everything; either way the
      // original file is still the one on disk, which is what matters.
    }
    throw error
  }
}

/**
 * Copies a file aside before a one-way rewrite. False means there was nothing to copy or the
 * backup already exists - a second upgrade must not overwrite the original bytes with the
 * already-migrated file.
 */
export function backupFile(filePath: string, backupPath: string): boolean {
  if (existsSync(backupPath) || !existsSync(filePath)) return false
  copyFileSync(filePath, backupPath)
  return true
}
