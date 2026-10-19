import { describe, expect, it } from 'vitest'
import { DOORBELL_SCHEME, doorbellRequested } from './doorbell'

describe('doorbellRequested', () => {
  it('hears a link the OS routed here', () => {
    expect(doorbellRequested(['C:\\app\\ctoe.exe', 'ctoe://wake'])).toBe(true)
  })

  it('does not care how the scheme is cased, or whether anything follows it', () => {
    // Any of these is a ring. Which one arrives depends on the shell, not on the user.
    expect(doorbellRequested(['app.exe', 'CTOE://wake'])).toBe(true)
    expect(doorbellRequested(['app.exe', 'CtOE://WaKe'])).toBe(true)
    expect(doorbellRequested(['app.exe', 'ctoe:'])).toBe(true)
    expect(doorbellRequested(['app.exe', 'ctoe://'])).toBe(true)
    expect(doorbellRequested(['app.exe', '  ctoe://wake  '])).toBe(true)
  })

  it('stays quiet for an ordinary launch', () => {
    expect(doorbellRequested(['app.exe'])).toBe(false)
    expect(doorbellRequested(['app.exe', '--no-sandbox'])).toBe(false)
    expect(doorbellRequested([])).toBe(false)
  })

  it('is not fooled by a path that merely spells the name', () => {
    // The scheme has to start the argument. A folder called ctoe, or a page that mentions it,
    // is not a doorbell - and treating one as a doorbell would pop the panel open for nothing.
    expect(doorbellRequested(['C:\\tools\\ctoe\\ctoe.exe'])).toBe(false)
    expect(doorbellRequested(['app.exe', 'https://ctoe.example.com/wake'])).toBe(false)
    expect(doorbellRequested(['app.exe', '--url=ctoe://wake'])).toBe(false)
  })

  it('reads nothing out of the link beyond its scheme', () => {
    // The rule this module exists for: a command line is forgeable, so a doorbell must not be
    // able to carry a sentence or a token. The answer is a boolean, so there is nowhere for one
    // to ride - a link full of them rings exactly like an empty one.
    const answer = doorbellRequested(['app.exe', 'ctoe://wake?text=hello&token=stolen'])
    expect(answer).toBe(true)
    expect(typeof answer).toBe('boolean')
  })

  it('names the one scheme it answers to', () => {
    expect(DOORBELL_SCHEME).toBe('ctoe')
  })
})
