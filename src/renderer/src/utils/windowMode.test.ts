import { describe, expect, it } from 'vitest'
import { readInitialWindowMode } from './windowMode'

describe('readInitialWindowMode', () => {
  it('reads the shape the main process put in the url', () => {
    expect(readInitialWindowMode('?view=ball')).toBe('ball')
    expect(readInitialWindowMode('?view=panel')).toBe('panel')
    expect(readInitialWindowMode('?foo=1&view=ball')).toBe('ball')
  })

  it('falls back to the panel when the url says nothing useful', () => {
    expect(readInitialWindowMode('')).toBe('panel')
    expect(readInitialWindowMode('?view=')).toBe('panel')
    expect(readInitialWindowMode('?view=triangle')).toBe('panel')
  })
})
