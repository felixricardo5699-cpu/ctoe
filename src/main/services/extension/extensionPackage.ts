import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

/** Name of the folder the extension is unpacked into, next to the app resources. */
const FOLDER_NAME = 'extension'

export interface ExtensionLocation {
  /** True for a packaged app (extraResources); false when running from the repo. */
  packaged: boolean
  /** Electron's process.resourcesPath. */
  resourcesPath: string
  /** Electron's app.getAppPath(). */
  appPath: string
}

/**
 * Where the browser extension sits on disk.
 *
 * The extension is part of this repository now: a checkout keeps it in `extension/` (the same
 * folder the browser is pointed at during development), and a packaged build gets a copy under
 * `resources/extension` from electron-builder. One path, two locations - no staging directory in
 * between, which is what used to leave a stale copy behind after an extension rebuild.
 */
export function bundledExtensionFolder(location: ExtensionLocation): string {
  return location.packaged
    ? join(location.resourcesPath, FOLDER_NAME)
    : join(location.appPath, FOLDER_NAME)
}

/**
 * Whether a folder is really a loadable extension.
 *
 * Chrome and Edge want a manifest at the root, and the manifest is useless without the parts it
 * names - so the service worker and the content script are checked too. A checkout that has never
 * run `npm run build:extension` has the manifest but no `dist`, and pointing a user at it would
 * produce a browser error rather than an extension.
 */
export function isLoadableExtension(folder: string): boolean {
  const required = ['manifest.json', 'dist/sw.mjs', 'dist/content.js']
  return required.every((name) => {
    try {
      accessSync(join(folder, name), constants.R_OK)
      return true
    } catch {
      return false
    }
  })
}
