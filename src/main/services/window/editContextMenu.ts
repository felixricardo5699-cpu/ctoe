import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

export interface EditMenuContext {
  isEditable: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

/**
 * Right-click menu for the text boxes. Electron ships no default menu, so without this
 * a right click does nothing at all - exactly where copy/paste is expected.
 * Kept pure so the rules can be unit tested without an Electron runtime.
 */
export function buildEditMenuTemplate(context: EditMenuContext): MenuItemConstructorOptions[] {
  // Only text fields get a menu; right clicking the harness/chrome stays silent.
  const isTextField = context.isEditable || context.canCopy
  if (!isTextField) return []

  const template: MenuItemConstructorOptions[] = []
  if (context.canCopy) template.push({ role: 'copy', label: '复制' })
  // Paste is offered only where it can actually land; a read-only box must not show it.
  if (context.isEditable && context.canPaste) template.push({ role: 'paste', label: '粘贴' })
  if (context.canSelectAll) template.push({ role: 'selectAll', label: '全选' })
  return template
}

/** Attaches the edit menu to a window's web contents. */
export function attachEditContextMenu(window: BrowserWindow): void {
  window.webContents.on('context-menu', (_event, params) => {
    const template = buildEditMenuTemplate({
      isEditable: params.isEditable,
      canCopy: params.editFlags.canCopy,
      canPaste: params.editFlags.canPaste,
      canSelectAll: params.editFlags.canSelectAll
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window })
  })
}
