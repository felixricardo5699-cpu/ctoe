import { nativeImage, type NativeImage } from 'electron'

/**
 * The tray icon is embedded as base64 PNG instead of shipping image files: the
 * packaged app then has no extra asset to lose, and the icon still works when the
 * app is started from an unusual working directory.
 *
 * Two sizes are stored because Windows picks the closest match for the taskbar,
 * which is what keeps the icon sharp at 150% / 200% display scaling.
 */
const ICON_16_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAArUlEQVR42mNgwAG4JE0tBVT9Q0EYxGYgFogaZhZqJV9+rJ//9j8yBomB5HBqZOWRklEN23EMXSM6BqkBqcUwgBjNyIZgOJtYzTCM4h1sfgbh7vVfwRibHEgPPLRx2fLi/V8wxiUPjh1QNOGyHQZwuQKkF6cBIJthAJcrwAZg8wKy7fhcAU9g6IGIbDsuV8ADET0a3erf/y+Z/xkrBslhjUaKExJVkjLFmYnc7AwAAmXPPoB1/QgAAAAASUVORK5CYII='

const ICON_32_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABG0lEQVR42mNgGGpAQNU/VMqupU/ea94qZAwSA8nRxFIuSVNLkCX6+W//E4NBakF6KLaYlUdKhhSLsTkEZAbZQa2VfPkxuZbDMMgMkqMGpIFSi9Ex0Y6gheVEOwIUX9QIdnzRgTdNUJLgSEmYOLMarS2HYaxZlBzfd6//CsZUCQVyfPLi/V8wJkcvxSkf5HMYICcUUHIEqBwnx/cwQE4ogOwkO/6RfU9uKKCkA1IdgOx7ckOBbAdg8z05oUC2A7D5npxQQHEAsYkQn+9JDQWUREhsNsTne1JDAaNioobvSQkFkotiYnxPbChgLYrxVUZu9e//l8z/TBIG6SGpMhrw6nhQNEgGvEk2KBqlg6JZPig6JoOiazZoOqe0BADaDDiQd9QxXQAAAABJRU5ErkJggg=='

let cached: NativeImage | null = null

/** Blue disc with an upward caret - readable on both light and dark taskbars. */
export function trayIcon(): NativeImage {
  if (cached !== null) return cached
  const image = nativeImage.createFromDataURL('data:image/png;base64,' + ICON_16_PNG)
  try {
    image.addRepresentation({
      scaleFactor: 2,
      buffer: nativeImage.createFromDataURL('data:image/png;base64,' + ICON_32_PNG).toPNG()
    })
  } catch {
    // A HiDPI representation is a nice-to-have; the 16px base still works without it.
  }
  cached = image
  return cached
}
