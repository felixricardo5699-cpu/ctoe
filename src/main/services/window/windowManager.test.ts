import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BALL_SIZE, PANEL_DEFAULTS } from '@shared/config/defaults'
import type { PublicSettings, Vec2 } from '@shared/types'
import { IPC } from '@shared/types/ipc'
import type { ConfigStore } from '../config/configStore'
import { FloatingWindowManager } from './windowManager'

interface Rect {
  x: number
  y: number
  width: number
  height: number
}

interface SentMessage {
  channel: string
  payload: unknown
}

interface FakeWebContents {
  isLoading(): boolean
  send(channel: string, payload: unknown): void
  on(channel: string, listener: (...args: never[]) => void): void
  once(channel: string, listener: (...args: never[]) => void): void
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void
  focus(): void
  getURL(): string
}

interface FakeWindow {
  options: Record<string, unknown>
  bounds: Rect
  visible: boolean
  top: boolean
  alwaysOnTop: boolean
  sent: SentMessage[]
  events: Map<string, Array<(...args: never[]) => void>>
  webContents: FakeWebContents
  setBounds(next: Rect): void
  getBounds(): Rect
  setPosition(x: number, y: number): void
  getPosition(): [number, number]
  show(): void
  showInactive(): void
  hide(): void
  focus(): void
  blur(): void
  moveTop(): void
  isVisible(): boolean
  isDestroyed(): boolean
  setAlwaysOnTop(value: boolean): void
  setVisibleOnAllWorkspaces(value: boolean): void
  on(channel: string, listener: (...args: never[]) => void): void
  once(channel: string, listener: (...args: never[]) => void): void
  loadFile(path: string, options: unknown): void
}

const h = vi.hoisted(() => ({
  created: [] as FakeWindow[],
  cursor: { x: 0, y: 0 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
  openExternal: [] as string[]
}))

vi.mock('electron', () => {
  function createWindow(options: Record<string, unknown>): FakeWindow {
    const events = new Map<string, Array<(...args: never[]) => void>>()
    const sent: SentMessage[] = []
    const window: FakeWindow = {
      options,
      bounds: {
        x: Number(options.x ?? 0),
        y: Number(options.y ?? 0),
        width: Number(options.width ?? 0),
        height: Number(options.height ?? 0)
      },
      visible: false,
      top: false,
      alwaysOnTop: false,
      sent,
      events,
      webContents: {
        isLoading: () => false,
        send: (channel, payload) => sent.push({ channel, payload }),
        on: (channel, listener) => events.set(channel, [...(events.get(channel) ?? []), listener]),
        once: (channel, listener) => events.set(channel, [...(events.get(channel) ?? []), listener]),
        setWindowOpenHandler: () => undefined,
        focus: () => undefined,
        getURL: () => 'file:///index.html'
      },
      setBounds: (next) => {
        window.bounds = { ...next }
      },
      getBounds: () => ({ ...window.bounds }),
      setPosition: (x, y) => {
        window.bounds = { ...window.bounds, x, y }
      },
      getPosition: () => [window.bounds.x, window.bounds.y],
      show: () => {
        window.visible = true
        window.top = true
      },
      showInactive: () => {
        window.visible = true
      },
      hide: () => {
        window.visible = false
      },
      focus: () => {
        window.top = true
      },
      blur: () => {
        window.top = false
      },
      moveTop: () => undefined,
      isVisible: () => window.visible,
      isDestroyed: () => false,
      setAlwaysOnTop: (value) => {
        window.alwaysOnTop = value
      },
      setVisibleOnAllWorkspaces: () => undefined,
      on: (channel, listener) => events.set(channel, [...(events.get(channel) ?? []), listener]),
      once: (channel, listener) => events.set(channel, [...(events.get(channel) ?? []), listener]),
      loadFile: () => undefined
    }
    h.created.push(window)
    return window
  }

  return {
    BrowserWindow: function BrowserWindow(options: Record<string, unknown>): FakeWindow {
      return createWindow(options)
    },
    screen: {
      getPrimaryDisplay: () => ({ id: 1, workArea: { ...h.workArea } }),
      getDisplayNearestPoint: () => ({ id: 1, workArea: { ...h.workArea } }),
      getCursorScreenPoint: () => ({ ...h.cursor }),
      on: () => undefined
    },
    shell: {
      openExternal: (url: string) => h.openExternal.push(url)
    }
  }
})

const SETTINGS: PublicSettings = {
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  tone: 'natural',
  providerKind: 'openai-compatible',
  nativeLanguage: 'zh',
  learningLanguage: 'en',
  hasApiKey: true,
  apiKeyEncrypted: true,
  floatingBall: true,
  globalShortcut: 'CommandOrControl+Shift+Space',
  launchAtLogin: false,
  recentPolicy: 'off',
  browserBridgePolicy: 'off'
}

interface FakeConfig {
  store: ConfigStore
  written: Vec2[]
}

function fakeConfig(options: { floatingBall?: boolean; ball?: Vec2 | null } = {}): FakeConfig {
  const written: Vec2[] = []
  const store = {
    readPublicSettings: () => ({ ...SETTINGS, floatingBall: options.floatingBall ?? true }),
    readPanelSize: () => null,
    readBallPosition: () => options.ball ?? null,
    writeBallPosition: (position: Vec2) => {
      written.push(position)
    }
  }
  return { store: store as unknown as ConfigStore, written }
}

function setup(options: { floatingBall?: boolean; ball?: Vec2 | null } = {}): {
  manager: FloatingWindowManager
  window: FakeWindow
  config: FakeConfig
} {
  const config = fakeConfig(options)
  const manager = new FloatingWindowManager(config.store)
  manager.init()
  const window = h.created[h.created.length - 1]
  if (window === undefined) throw new Error('window was not created')
  return { manager, window, config }
}

function modeEvents(window: FakeWindow): Array<{ mode: string; anchor: string }> {
  return window.sent
    .filter((message) => message.channel === IPC.windowMode)
    .map((message) => message.payload as { mode: string; anchor: string })
}

beforeEach(() => {
  h.created.length = 0
  h.openExternal.length = 0
  h.cursor = { x: 0, y: 0 }
  h.workArea = { x: 0, y: 0, width: 1920, height: 1040 }
  vi.useFakeTimers()
})

describe('FloatingWindowManager', () => {
  it('starts as a frameless, transparent, always-on-top ball that never steals focus', () => {
    const { manager, window } = setup()

    expect(window.options.frame).toBe(false)
    expect(window.options.transparent).toBe(true)
    expect(window.options.skipTaskbar).toBe(true)
    expect(window.alwaysOnTop).toBe(true)
    expect(window.bounds.width).toBe(BALL_SIZE)
    expect(window.bounds.height).toBe(BALL_SIZE)
    expect(manager.currentMode).toBe('ball')

    // Shown without activation: the ball must not pull focus from other apps.
    ;(window.events.get('ready-to-show') ?? []).forEach((listener) => listener())
    expect(window.top).toBe(false)
    expect(window.visible).toBe(true)
  })

  it('opens the panel above the ball when there is no room below', () => {
    h.workArea = { x: 0, y: 0, width: 1280, height: 720 }
    const { manager, window } = setup({ ball: { x: 100, y: 640 } })

    manager.expand()

    const [event] = modeEvents(window)
    expect(event?.anchor).toBe('above')
    expect(event?.mode).toBe('panel')
    expect(window.bounds.width).toBe(PANEL_DEFAULTS.width)
    expect(window.bounds.height).toBe(PANEL_DEFAULTS.height)
    expect(window.bounds.y + window.bounds.height).toBeLessThanOrEqual(720)
    expect(window.top).toBe(true)
  })

  it('returns the ball to where it was when the panel collapses', () => {
    const { manager, window } = setup({ ball: { x: 300, y: 300 } })
    const original = { ...window.bounds }

    manager.expand()
    expect(manager.currentMode).toBe('panel')

    manager.collapse()

    expect(manager.currentMode).toBe('ball')
    expect(window.bounds).toEqual(original)
    expect(window.top).toBe(false)
    expect(modeEvents(window).map((event) => event.mode)).toEqual(['panel', 'ball'])
  })

  it('toggles between the two shapes', () => {
    const { manager } = setup()

    manager.toggle()
    expect(manager.currentMode).toBe('panel')
    manager.toggle()
    expect(manager.currentMode).toBe('ball')
  })

  it('treats a press that never moved as a click and opens the panel', () => {
    const { manager, window, config } = setup({ ball: { x: 400, y: 400 } })

    manager.startDrag()
    vi.advanceTimersByTime(48)
    manager.endDrag()

    expect(manager.currentMode).toBe('panel')
    expect(config.written).toEqual([])
    expect(window.bounds.width).toBe(PANEL_DEFAULTS.width)
  })

  it('moves the window while dragging and stores the new position', () => {
    const { manager, window, config } = setup({ ball: { x: 400, y: 400 } })

    manager.startDrag()
    h.cursor = { x: 40, y: 25 }
    vi.advanceTimersByTime(16)
    h.cursor = { x: 90, y: 55 }
    vi.advanceTimersByTime(16)
    manager.endDrag()

    expect(window.bounds.x).toBe(490)
    expect(window.bounds.y).toBe(455)
    expect(config.written).toEqual([{ x: 490, y: 455 }])
    expect(manager.currentMode).toBe('ball')
  })

  it('pulls a stored ball position back onto the screen', () => {
    // The monitor the ball was on is gone: -4000 is nowhere near the work area.
    const { window } = setup({ ball: { x: -4000, y: 3000 } })

    expect(window.bounds.x).toBeGreaterThanOrEqual(0)
    expect(window.bounds.y).toBeGreaterThanOrEqual(0)
    expect(window.bounds.x + window.bounds.width).toBeLessThanOrEqual(h.workArea.width)
  })

  it('resizes the panel to fit a smaller screen after a display change', () => {
    const { manager, window } = setup({ ball: { x: 100, y: 100 } })
    manager.expand()

    h.workArea = { x: 0, y: 0, width: 800, height: 600 }
    manager.handleDisplayChange()

    expect(window.bounds.width).toBeLessThanOrEqual(800)
    expect(window.bounds.height).toBeLessThanOrEqual(600)
    expect(window.bounds.x + window.bounds.width).toBeLessThanOrEqual(800)
  })

  it('hides and restores the ball from the tray', () => {
    const { manager, window } = setup()
    ;(window.events.get('ready-to-show') ?? []).forEach((listener) => listener())

    expect(manager.toggleBallVisibility()).toBe(false)
    expect(window.visible).toBe(false)
    expect(manager.toggleBallVisibility()).toBe(true)
    expect(window.visible).toBe(true)
  })

  it('leaves ball mode when the floating ball is disabled in settings', () => {
    const { manager, window } = setup()

    manager.setFloatingBall(false)

    expect(manager.currentMode).toBe('panel')
    expect(window.bounds.width).toBe(PANEL_DEFAULTS.width)
  })

  it('pushes arbitrary main -> renderer messages over ipc', () => {
    const { manager, window } = setup()

    manager.send(IPC.uiOpenSettings, null)

    expect(window.sent).toEqual([{ channel: IPC.uiOpenSettings, payload: null }])
  })
})
