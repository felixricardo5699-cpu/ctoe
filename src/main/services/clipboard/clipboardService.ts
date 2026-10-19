import { clipboard } from 'electron'

/**
 * Copying through the main process avoids renderer clipboard permissions and the
 * "document not focused" failures that navigator.clipboard hits in Electron.
 * Electron 44 made these calls async, so both helpers are promises.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (text.length === 0) return false
  try {
    await clipboard.writeText(text)
    return true
  } catch {
    // Nothing useful to tell the user beyond "the copy did not happen".
    return false
  }
}

/**
 * Reading goes through main for the same reason as writing: the renderer would need a
 * focused document and a permission, and the panel is often shown without focus.
 * Rejections are left to the caller so the UI can say the clipboard was unreadable.
 */
export function readFromClipboard(): Promise<string> {
  return clipboard.readText()
}
