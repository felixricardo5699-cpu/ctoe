import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShortcutStatus } from '@shared/types'
import type { ConfigStore } from '../config/configStore'
import { GlobalShortcutService } from './globalShortcutService'

const h = vi.hoisted(() => ({
  registered: [] as string[],
  taken: new Set<string>(),
  throwOn: new Set<string>()
}))

vi.mock('electron', () => ({
  globalShortcut: {
    register: (accelerator: string, callback: () => void) => {
      if (h.throwOn.has(accelerator)) throw new Error('invalid accelerator')
      if (h.taken.has(accelerator)) return false
      h.registered.push(accelerator)
      void callback
      return true
    },
    unregister: (accelerator: string) => {
      const index = h.registered.indexOf(accelerator)
      if (index >= 0) h.registered.splice(index, 1)
    },
    unregisterAll: () => {
      h.registered.length = 0
    }
  }
}))

function fakeConfig(stored = 'CommandOrControl+Shift+Space'): { store: ConfigStore; saved: string[] } {
  const saved: string[] = []
  const store = {
    readPublicSettings: () => ({ globalShortcut: stored }),
    setGlobalShortcut: (accelerator: string) => {
      saved.push(accelerator)
      stored = accelerator
      return { globalShortcut: accelerator }
    }
  }
  return { store: store as unknown as ConfigStore, saved }
}

function setup(stored?: string): {
  service: GlobalShortcutService
  statuses: ShortcutStatus[]
  saved: string[]
  triggers: () => number
} {
  const config = fakeConfig(stored)
  const statuses: ShortcutStatus[] = []
  let triggered = 0
  const service = new GlobalShortcutService(config.store, {
    onTrigger: () => {
      triggered += 1
    },
    onStatus: (status) => statuses.push(status)
  })
  return { service, statuses, saved: config.saved, triggers: () => triggered }
}

beforeEach(() => {
  h.registered.length = 0
  h.taken.clear()
  h.throwOn.clear()
})

describe('GlobalShortcutService', () => {
  it('registers the stored shortcut on startup', () => {
    const { service, statuses } = setup()

    const status = service.init()

    expect(status.ok).toBe(true)
    expect(status.accelerator).toBe('CommandOrControl+Shift+Space')
    expect(h.registered).toEqual(['CommandOrControl+Shift+Space'])
    // The renderer is told about the state without having to ask.
    expect(statuses).toHaveLength(1)
  })

  it('reports a friendly message when the stored shortcut is already taken', () => {
    h.taken.add('CommandOrControl+Shift+Space')
    const { service } = setup()

    const status = service.init()

    expect(status.ok).toBe(false)
    expect(status.message.length).toBeGreaterThan(0)
  })

  it('persists a shortcut only after the OS accepted it', () => {
    const { service, saved, statuses } = setup()
    service.init()
    statuses.length = 0

    const status = service.set('ctrl+alt+q')

    expect(status).toEqual({ ok: true, accelerator: 'Control+Alt+Q', message: '' })
    expect(saved).toEqual(['Control+Alt+Q'])
    expect(h.registered).toEqual(['Control+Alt+Q'])
    expect(statuses).toHaveLength(1)
  })

  it('keeps the previous shortcut when the new one is taken', () => {
    h.taken.add('Control+Alt+Q')
    const { service, saved } = setup()
    service.init()

    const status = service.set('Ctrl+Alt+Q')

    expect(status.ok).toBe(false)
    expect(status.accelerator).toBe('CommandOrControl+Shift+Space')
    expect(status.message).toContain('占用')
    expect(saved).toEqual([])
    expect(h.registered).toEqual(['CommandOrControl+Shift+Space'])
  })

  it('survives an accelerator the OS refuses to parse', () => {
    h.throwOn.add('Control+Notakey')
    const { service } = setup()
    service.init()

    const status = service.set('ctrl+notakey')

    expect(status.ok).toBe(false)
    expect(h.registered).toEqual(['CommandOrControl+Shift+Space'])
  })

  it('rejects empty or absurdly long input without touching the OS', () => {
    const { service, saved } = setup()
    service.init()

    expect(service.set('   ').ok).toBe(false)
    expect(service.set('a'.repeat(200)).ok).toBe(false)
    expect(saved).toEqual([])
  })

  it('unregisters everything on dispose', () => {
    const { service } = setup()
    service.init()

    service.dispose()

    expect(h.registered).toEqual([])
    expect(service.status().ok).toBe(false)
  })
})
