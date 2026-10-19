import { globalShortcut } from 'electron'
import type { ShortcutStatus } from '@shared/types'
import type { ConfigStore } from '../config/configStore'
import { describeAccelerator, normalizeAccelerator } from './accelerator'

/** Guard against a pasted paragraph being handed to the OS keyboard hook. */
const MAX_ACCELERATOR_LENGTH = 64

export interface GlobalShortcutHost {
  onTrigger(): void
  onStatus(status: ShortcutStatus): void
}

/**
 * Owns the one system-wide shortcut. Registration can fail (another app already owns
 * the combination), so the stored value only changes after the OS accepted it - the
 * user is never left with a shortcut that silently does nothing.
 */
export class GlobalShortcutService {
  private accelerator = ''
  private registered = false
  private message = ''

  constructor(
    private readonly config: ConfigStore,
    private readonly host: GlobalShortcutHost
  ) {}

  init(): ShortcutStatus {
    const stored = this.config.readPublicSettings().globalShortcut
    this.accelerator = stored
    this.registered = this.register(stored)
    this.message = this.registered ? '' : '这个快捷键无法注册，可能已被其它程序占用。'
    return this.publish()
  }

  /**
   * "ok" means "the shortcut in this status is live and nothing went wrong": after a
   * rejected attempt the previous accelerator is registered again, but the status still
   * has to report a failure so the settings page can explain what happened.
   */
  status(): ShortcutStatus {
    return {
      ok: this.registered && this.message.length === 0,
      accelerator: this.accelerator,
      message: this.message
    }
  }

  /** Applies a user-supplied shortcut, falling back to the previous one on failure. */
  set(input: string): ShortcutStatus {
    const next = normalizeAccelerator(input)
    if (next.length === 0 || next.length > MAX_ACCELERATOR_LENGTH) {
      this.message = '快捷键格式不对，请使用类似 Ctrl+Shift+Space 的写法。'
      return this.publish()
    }
    if (next === this.accelerator && this.registered) {
      this.message = ''
      return this.publish()
    }

    const previous = this.accelerator
    const previousWorked = this.registered
    this.unregister(previous)

    if (this.register(next)) {
      this.accelerator = next
      this.registered = true
      this.message = ''
      this.config.setGlobalShortcut(next)
      return this.publish()
    }

    // Roll back so the user keeps whatever worked before this attempt.
    this.accelerator = previous
    this.registered = previousWorked && this.register(previous)
    this.message = '这个快捷键已被其它程序占用，请换一个。'
    return this.publish()
  }

  dispose(): void {
    this.unregister(this.accelerator)
    this.registered = false
  }

  private register(accelerator: string): boolean {
    if (accelerator.length === 0 || accelerator.length > MAX_ACCELERATOR_LENGTH) return false
    try {
      return globalShortcut.register(accelerator, () => this.host.onTrigger())
    } catch {
      // A malformed accelerator throws instead of returning false.
      return false
    }
  }

  private unregister(accelerator: string): void {
    if (accelerator.length === 0) return
    try {
      globalShortcut.unregister(accelerator)
    } catch {
      // Nothing to unregister.
    }
  }

  private publish(): ShortcutStatus {
    const status = this.status()
    this.host.onStatus(status)
    return status
  }
}

export { describeAccelerator }
