import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, shell } from 'electron'
import type { FilesController } from '../../ipc/handlers'
import { writeDocuments } from './learningExport'

/**
 * The only place in the app that opens an OS dialog or a file manager.
 *
 * The IPC layer takes this as an interface, which is what lets the export be tested without a
 * human clicking a folder picker. Everything here is a thin adapter: the deciding, the layout and
 * the file writing all live somewhere else.
 */

/** The folder exports default to, inside the user's Documents. */
const EXPORT_FOLDER = 'ctoe 学习记录'

export function createFilesController(): FilesController {
  return {
    dataFolder(): string {
      return app.getPath('userData')
    },

    /**
     * Creates the default export folder before it is handed to the dialog, so the picker opens
     * *inside* it rather than at the nearest existing parent. A machine that refuses to create it
     * (read-only Documents, odd redirect) falls back to Documents itself rather than failing the
     * export - the user can still choose a folder from there.
     */
    exportFolder(): string {
      const documents = app.getPath('documents')
      const folder = join(documents, EXPORT_FOLDER)
      try {
        mkdirSync(folder, { recursive: true })
        return folder
      } catch {
        return documents
      }
    },

    async openFolder(folder: string): Promise<string> {
      try {
        return await shell.openPath(folder)
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },

    async chooseFolder(defaultFolder: string): Promise<string | null> {
      const answer = await dialog.showOpenDialog({
        title: '选择导出文件夹',
        buttonLabel: '导出到这里',
        defaultPath: defaultFolder,
        properties: ['openDirectory', 'createDirectory']
      })
      if (answer.canceled) return null
      return answer.filePaths[0] ?? null
    },

    async writeDocuments(folder, documents) {
      return writeDocuments(folder, documents, new Date())
    },

    revealFile(file: string): void {
      // Selecting it is the answer to "where did the file go": the window opens at that row
      // rather than at some folder the user has to hunt through.
      shell.showItemInFolder(file)
    }
  }
}
