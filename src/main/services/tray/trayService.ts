import { Menu, Tray, type MenuItemConstructorOptions } from 'electron'
import { trayIcon } from './icon'

/** Everything the tray menu can ask the rest of the app to do. */
export interface TrayActions {
  openPanel(): void
  openSettings(): void
  isBallVisible(): boolean
  /** Toggles the ball's visibility and reports the new state. */
  toggleBall(): boolean
  shortcutLabel(): string
  quit(): void
}

/**
 * Optional-but-cheap desktop integration: a tray icon is the safety net that makes
 * "hide the window" safe, because there is always a way back to the app without
 * knowing the global shortcut.
 */
export class TrayService {
  private tray: Tray | null = null

  constructor(private readonly actions: TrayActions) {}

  init(): void {
    if (this.tray !== null) return
    const tray = new Tray(trayIcon())
    tray.setToolTip('AI Language Coach')
    tray.setContextMenu(Menu.buildFromTemplate(this.buildTemplate()))
    this.tray = tray
    // Left click is the fastest way back to the panel; the menu stays on right click.
    tray.on('click', () => this.actions.openPanel())
  }

  /** Called after actions that change what the menu should offer. */
  refresh(): void {
    this.tray?.setContextMenu(Menu.buildFromTemplate(this.buildTemplate()))
  }

  dispose(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private buildTemplate(): MenuItemConstructorOptions[] {
    return [
      { label: '打开 AI Language Coach', click: () => this.actions.openPanel() },
      {
        label: this.actions.isBallVisible() ? '隐藏悬浮球' : '显示悬浮球',
        click: () => {
          this.actions.toggleBall()
          this.refresh()
        }
      },
      { type: 'separator' },
      { label: '设置…', click: () => this.actions.openSettings() },
      {
        label: '快捷键：' + this.actions.shortcutLabel(),
        click: () => this.actions.openSettings()
      },
      { type: 'separator' },
      { label: '退出', click: () => this.actions.quit() }
    ]
  }
}
