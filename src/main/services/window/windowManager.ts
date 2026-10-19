import { BrowserWindow, screen, shell } from 'electron'
import { join } from 'node:path'
import { BALL_SIZE, DRAG_CLICK_THRESHOLD, PANEL_DEFAULTS } from '@shared/config/defaults'
import type { PanelAnchor, PanelSize, WindowMode } from '@shared/types'
import { IPC, type WindowModePayload } from '@shared/types/ipc'
import type { ConfigStore } from '../config/configStore'
import {
  clampToWorkArea,
  defaultBallPosition,
  isFullyVisible,
  normalizeBallPosition,
  normalizePanelSize,
  placePanel,
  type Rect
} from './windowGeometry'

/** Cursor polling only runs while the user is actually dragging the ball. */
const DRAG_POLL_INTERVAL_MS = 16
const POSITION_SAVE_DELAY_MS = 300
/** Last-resort reveal in case 'ready-to-show' never fires on an odd GPU/driver combo. */
const REVEAL_FALLBACK_MS = 2_000

/**
 * Owns the single window the app has. It is one frameless, transparent window that
 * morphs between the floating ball and the AI panel, which keeps the translation
 * state alive across collapse/expand and avoids keeping two renderers in sync.
 */
export class FloatingWindowManager {
  private window: BrowserWindow | null = null
  private mode: WindowMode = 'ball'
  private panelSize: PanelSize = PANEL_DEFAULTS
  private ballPosition = { x: 0, y: 0 }
  private anchor: PanelAnchor = 'below'
  private dragTimer: NodeJS.Timeout | null = null
  private dragging = false
  private dragStart: { x: number; y: number } | null = null
  private dragLastCursor: { x: number; y: number } | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private revealTimer: NodeJS.Timeout | null = null
  private revealed = false
  private suppressMovePersist = false

  constructor(private readonly config: ConfigStore) {}

  /** Creates the window in whichever shape the settings ask for. */
  init(): BrowserWindow {
    const workArea = screen.getPrimaryDisplay().workArea
    this.mode = this.config.readPublicSettings().floatingBall ? 'ball' : 'panel'
    this.panelSize = normalizePanelSize(this.config.readPanelSize() ?? PANEL_DEFAULTS, workArea)
    this.ballPosition = this.resolveBallPosition()

    const placement = this.panelBounds(this.ballPosition)
    this.anchor = placement.anchor
    const bounds = this.mode === 'ball' ? this.ballBounds() : placement.bounds

    const window = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      thickFrame: false,
      // The user cannot resize either shape, but programmatic setBounds() is only
      // reliable on Windows when the window is technically resizable.
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      title: 'AI Language Coach',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    this.window = window
    window.setAlwaysOnTop(true, 'floating')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false })

    wireNavigationGuards(window)
    wireDisplayChanges(this)
    window.webContents.on('did-finish-load', () => this.emitMode())
    window.on('moved', () => this.handleMoved())
    window.on('closed', () => {
      this.clearTimers()
      this.window = null
    })

    loadRenderer(window, this.mode)
    this.revealTimer = setTimeout(() => this.reveal(), REVEAL_FALLBACK_MS)
    window.once('ready-to-show', () => this.reveal())
    return window
  }

  /** Ball -> panel. Focuses the window so the renderer can focus the input straight away. */
  expand(): void {
    const window = this.window
    if (window === null) return
    if (this.mode === 'panel') {
      this.focusPanel()
      this.emitMode()
      return
    }
    this.updateBallPositionFromWindow()
    const placement = this.panelBounds(this.ballPosition)
    this.anchor = placement.anchor
    this.mode = 'panel'
    this.setBounds(placement.bounds)
    window.show()
    this.focusPanel()
    this.emitMode()
  }

  /** Panel -> ball. The app keeps running; only the tray / quit entry point exits. */
  collapse(): void {
    const window = this.window
    if (window === null || this.mode === 'ball') return
    this.mode = 'ball'
    this.anchor = 'below'
    this.setBounds(this.ballBounds())
    window.showInactive()
    this.emitMode()
    // Hand focus back to whatever the user was doing before the panel opened.
    window.blur()
    this.persistBallPosition()
  }

  toggle(): void {
    if (this.mode === 'ball') this.expand()
    else this.collapse()
  }

  /** Hides the window completely; the tray icon and the shortcut bring it back. */
  hide(): void {
    this.window?.hide()
  }

  isBallVisible(): boolean {
    return this.window?.isVisible() ?? false
  }

  /** Tray: hide the ball, or bring it back. Returns the new visibility. */
  toggleBallVisibility(): boolean {
    const window = this.window
    if (window === null) return false
    if (window.isVisible() && this.mode === 'ball') {
      window.hide()
      return false
    }
    this.showBall()
    return true
  }

  /** Settings -> "Enable floating ball": switching between ball and classic window mode. */
  setFloatingBall(enabled: boolean): void {
    const window = this.window
    if (window === null) return
    if (enabled) {
      this.showBall()
      return
    }
    if (this.mode === 'ball') this.expand()
  }

  showBall(): void {
    const window = this.window
    if (window === null) return
    if (this.mode === 'panel') this.collapse()
    window.showInactive()
  }

  /** The shape and placement the renderer needs to pick the right view. */
  windowMode(): WindowModePayload {
    return { mode: this.mode, anchor: this.anchor }
  }

  /** Main -> renderer push, safe while the page is still loading. */
  send(channel: string, payload: unknown): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    if (window.webContents.isLoading()) {
      window.webContents.once('did-finish-load', () => {
        if (this.window !== null && !this.window.isDestroyed()) this.window.webContents.send(channel, payload)
      })
      return
    }
    window.webContents.send(channel, payload)
  }

  startDrag(): void {
    const window = this.window
    if (window === null || window.isDestroyed() || this.mode !== 'ball') return
    this.stopDragTimer()
    this.dragging = true
    const [x, y] = window.getPosition()
    this.dragStart = { x, y }
    this.dragLastCursor = screen.getCursorScreenPoint()
    this.dragTimer = setInterval(() => this.stepDrag(), DRAG_POLL_INTERVAL_MS)
  }

  /**
   * Ends a drag. A press that never really moved counts as a click, which is how the
   * ball opens the panel; anything else snaps the ball into a visible area and saves it.
   */
  endDrag(): void {
    const window = this.window
    const wasDragging = this.dragging
    const start = this.dragStart
    this.stopDragTimer()
    this.dragging = false
    this.dragStart = null
    this.dragLastCursor = null
    if (window === null || window.isDestroyed() || !wasDragging || this.mode !== 'ball') return

    const [x, y] = window.getPosition()
    if (
      start !== null &&
      Math.abs(x - start.x) < DRAG_CLICK_THRESHOLD &&
      Math.abs(y - start.y) < DRAG_CLICK_THRESHOLD
    ) {
      this.ballPosition = start
      this.setBounds(this.ballBounds(start))
      this.expand()
      return
    }

    const display = screen.getDisplayNearestPoint({ x, y })
    this.setBounds(this.ballBounds(normalizeBallPosition({ x, y }, BALL_SIZE, display.workArea)))
    this.persistBallPosition()
  }

  dispose(): void {
    this.clearTimers()
  }

  get currentMode(): WindowMode {
    return this.mode
  }

  /** Target of the display add/remove/metrics listeners. */
  handleDisplayChange(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    if (this.mode === 'ball') {
      const [x, y] = window.getPosition()
      const display = screen.getDisplayNearestPoint({ x, y })
      const size: PanelSize = { width: BALL_SIZE, height: BALL_SIZE }
      if (isFullyVisible({ x, y }, size, display.workArea)) return
      this.setBounds(this.ballBounds(normalizeBallPosition({ x, y }, BALL_SIZE, display.workArea)))
      this.persistBallPosition()
      return
    }
    const bounds = window.getBounds()
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y })
    const size = normalizePanelSize(this.panelSize, display.workArea)
    this.setBounds({ ...clampToWorkArea({ x: bounds.x, y: bounds.y }, size, display.workArea), ...size })
  }

  /**
   * Moves the window by the distance the pointer travelled instead of by an absolute
   * offset: with an absolute offset a mixed-DPI setup accumulates a constant error as
   * soon as the pointer crosses onto a monitor with a different scale factor.
   */
  private stepDrag(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const last = this.dragLastCursor
    this.dragLastCursor = cursor
    if (last === null) return
    const dx = cursor.x - last.x
    const dy = cursor.y - last.y
    if (dx === 0 && dy === 0) return
    const [x, y] = window.getPosition()
    this.suppressMovePersist = true
    window.setPosition(Math.round(x + dx), Math.round(y + dy))
    this.suppressMovePersist = false
  }

  private reveal(): void {
    if (this.revealTimer !== null) {
      clearTimeout(this.revealTimer)
      this.revealTimer = null
    }
    const window = this.window
    if (window === null || window.isDestroyed() || this.revealed) return
    this.revealed = true
    if (this.mode === 'ball') window.showInactive()
    else {
      window.show()
      this.focusPanel()
    }
  }

  private focusPanel(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    window.moveTop()
    window.focus()
    window.webContents.focus()
  }

  private ballBounds(position?: { x: number; y: number }): Rect {
    const point = position ?? this.ballPosition
    return { x: point.x, y: point.y, width: BALL_SIZE, height: BALL_SIZE }
  }

  private panelBounds(ball: { x: number; y: number }): { bounds: Rect; anchor: PanelAnchor } {
    const center = { x: ball.x + BALL_SIZE / 2, y: ball.y + BALL_SIZE / 2 }
    const display = screen.getDisplayNearestPoint(center)
    const size = normalizePanelSize(this.panelSize, display.workArea)
    const placement = placePanel(ball, BALL_SIZE, size, display.workArea)
    return { bounds: placement.bounds, anchor: placement.anchor }
  }

  private setBounds(bounds: Rect): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    window.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height)
    })
  }

  private resolveBallPosition(): { x: number; y: number } {
    const stored = this.config.readBallPosition()
    const primary = screen.getPrimaryDisplay().workArea
    if (stored === null) return defaultBallPosition(BALL_SIZE, primary)
    // The monitor the ball was last on may be gone; clamp into whichever display is nearest.
    const display = screen.getDisplayNearestPoint(stored)
    return normalizeBallPosition(stored, BALL_SIZE, display.workArea)
  }

  private updateBallPositionFromWindow(): void {
    const window = this.window
    if (window === null || window.isDestroyed()) return
    const [x, y] = window.getPosition()
    this.ballPosition = { x, y }
  }

  private handleMoved(): void {
    if (this.suppressMovePersist || this.dragging) return
    if (this.mode !== 'ball') return
    this.updateBallPositionFromWindow()
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.persistBallPosition()
    }, POSITION_SAVE_DELAY_MS)
  }

  private persistBallPosition(): void {
    const window = this.window
    if (window === null || window.isDestroyed() || this.mode !== 'ball') return
    const [x, y] = window.getPosition()
    this.ballPosition = { x, y }
    this.config.writeBallPosition({ x, y })
  }

  private emitMode(): void {
    this.send(IPC.windowMode, this.windowMode())
  }

  private stopDragTimer(): void {
    if (this.dragTimer !== null) clearInterval(this.dragTimer)
    this.dragTimer = null
  }

  private clearTimers(): void {
    this.stopDragTimer()
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    if (this.revealTimer !== null) clearTimeout(this.revealTimer)
    this.saveTimer = null
    this.revealTimer = null
  }
}

function wireDisplayChanges(manager: FloatingWindowManager): void {
  const onChange = (): void => manager.handleDisplayChange()
  screen.on('display-removed', onChange)
  screen.on('display-added', onChange)
  screen.on('display-metrics-changed', onChange)
}

function wireNavigationGuards(window: BrowserWindow): void {
  // The tool never browses: anything external opens in the user's own browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    if (url === window.webContents.getURL()) return
    event.preventDefault()
    openExternalIfSafe(url)
  })
}

function openExternalIfSafe(url: string): void {
  if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
}

/** The initial shape travels in the URL so the renderer never paints the wrong view. */
function loadRenderer(window: BrowserWindow, mode: WindowMode): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl !== undefined && devServerUrl.length > 0) {
    void window.loadURL(devServerUrl + '?view=' + mode)
    return
  }
  void window.loadFile(join(__dirname, '../renderer/index.html'), { query: { view: mode } })
}
