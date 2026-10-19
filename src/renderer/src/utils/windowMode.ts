import { isWindowMode, type WindowMode } from '@shared/types'

/**
 * The main process puts the initial shape in the URL (?view=ball|panel) so the very
 * first paint is already the right view instead of flashing the panel and shrinking.
 */
export function readInitialWindowMode(search: string, fallback: WindowMode = 'panel'): WindowMode {
  try {
    const value = new URLSearchParams(search).get('view')
    return isWindowMode(value) ? value : fallback
  } catch {
    return fallback
  }
}
