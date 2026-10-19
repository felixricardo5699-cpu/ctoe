/**
 * Users type shortcuts the way they think about them ("ctrl+shift+space"), while
 * Electron wants its own spelling ("CommandOrControl+Shift+Space"). Normalising here
 * keeps that detail out of both the settings UI and the registration code.
 */
const MODIFIERS: Record<string, string> = {
  ctrl: 'Control',
  control: 'Control',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  cmd: 'Command',
  command: 'Command',
  commandorcontrol: 'CommandOrControl',
  cmdorctrl: 'CommandOrControl',
  super: 'Super',
  meta: 'Super'
}

const KEY_NAMES: Record<string, string> = {
  space: 'Space',
  spacebar: 'Space',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  comma: 'Comma',
  period: 'Period',
  slash: 'Slash'
}

/** Returns '' when the input cannot be a shortcut at all. */
export function normalizeAccelerator(input: string): string {
  const parts = input
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  if (parts.length === 0 || parts.length > 8) return ''

  const normalized = parts.map(part => {
    const lower = part.toLowerCase()
    if (MODIFIERS[lower] !== undefined) return MODIFIERS[lower]
    if (KEY_NAMES[lower] !== undefined) return KEY_NAMES[lower]
    if (part.length === 1) return part.toUpperCase()
    if (/^f\d{1,2}$/i.test(part)) return part.toLowerCase()
    return part[0] !== undefined ? part[0].toUpperCase() + part.slice(1) : part
  })
  return normalized.join('+')
}

/** Human-readable form for the tray menu and status messages. */
export function describeAccelerator(accelerator: string): string {
  return accelerator.replace(/CommandOrControl/gi, 'Ctrl').replace(/\+/g, ' + ')
}
