import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { attachEditContextMenu, buildEditMenuTemplate } from './editContextMenu'

const popup = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  Menu: { buildFromTemplate: (template: unknown) => ({ template, popup }) }
}))

interface FakeWindow {
  window: BrowserWindow
  fire(params: unknown): void
}

function fakeWindow(): FakeWindow {
  let handler: ((event: unknown, params: unknown) => void) | null = null
  const window = {
    webContents: {
      on: (_channel: string, listener: (event: unknown, params: unknown) => void) => {
        handler = listener
      }
    }
  } as unknown as BrowserWindow
  return {
    window,
    fire: (params) => handler?.({}, params)
  }
}

const params = (overrides: Record<string, unknown> = {}): unknown => ({
  isEditable: true,
  editFlags: { canCopy: false, canPaste: true, canSelectAll: true },
  ...overrides
})

describe('buildEditMenuTemplate', () => {
  it('gives the editable input box copy/paste/select-all', () => {
    const roles = buildEditMenuTemplate({
      isEditable: true,
      canCopy: true,
      canPaste: true,
      canSelectAll: true
    }).map((item) => item.role)
    expect(roles).toEqual(['copy', 'paste', 'selectAll'])
  })

  it('never offers paste in a read-only box, but keeps copy for the English result', () => {
    const roles = buildEditMenuTemplate({
      isEditable: false,
      canCopy: true,
      canPaste: true,
      canSelectAll: true
    }).map((item) => item.role)
    expect(roles).toEqual(['copy', 'selectAll'])
  })

  it('stays empty where there is no text field, so the chrome has no menu', () => {
    expect(
      buildEditMenuTemplate({ isEditable: false, canCopy: false, canPaste: true, canSelectAll: true })
    ).toEqual([])
  })
})

describe('attachEditContextMenu', () => {
  it('pops the menu up for the input box', () => {
    popup.mockClear()
    const fake = fakeWindow()
    attachEditContextMenu(fake.window)
    fake.fire(params())
    expect(popup).toHaveBeenCalledTimes(1)
  })

  it('does not pop up an empty menu', () => {
    popup.mockClear()
    const fake = fakeWindow()
    attachEditContextMenu(fake.window)
    fake.fire(params({ isEditable: false, editFlags: { canCopy: false, canPaste: false, canSelectAll: false } }))
    expect(popup).not.toHaveBeenCalled()
  })
})
