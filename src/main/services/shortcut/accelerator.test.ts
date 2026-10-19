import { describe, expect, it } from 'vitest'
import { describeAccelerator, normalizeAccelerator } from './accelerator'

describe('normalizeAccelerator', () => {
  it('accepts the shorthand users actually type', () => {
    expect(normalizeAccelerator('ctrl+shift+space')).toBe('Control+Shift+Space')
    expect(normalizeAccelerator('Ctrl + Alt + Q')).toBe('Control+Alt+Q')
    expect(normalizeAccelerator('commandorcontrol+shift+space')).toBe('CommandOrControl+Shift+Space')
  })

  it('maps platform-flavoured modifier names onto electron spellings', () => {
    expect(normalizeAccelerator('cmd+alt+p')).toBe('Command+Alt+P')
    expect(normalizeAccelerator('super+shift+1')).toBe('Super+Shift+1')
  })

  it('normalises well-known key names', () => {
    expect(normalizeAccelerator('ctrl+return')).toBe('Control+Enter')
    expect(normalizeAccelerator('ctrl+escape')).toBe('Control+Escape')
    expect(normalizeAccelerator('alt+f4')).toBe('Alt+f4')
  })

  it('rejects input that cannot be a shortcut', () => {
    expect(normalizeAccelerator('')).toBe('')
    expect(normalizeAccelerator('   ')).toBe('')
    expect(normalizeAccelerator('+')).toBe('')
    expect(normalizeAccelerator('ctrl+alt+shift+super+a+b+c+d+e')).toBe('')
  })
})

describe('describeAccelerator', () => {
  it('turns electron spellings back into something a user recognises', () => {
    expect(describeAccelerator('CommandOrControl+Shift+Space')).toBe('Ctrl + Shift + Space')
  })
})
