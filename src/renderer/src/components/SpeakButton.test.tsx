// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { LanguageCode } from '@shared/language/registry'
import { SpeakButton } from './SpeakButton'

/** One spoken line as the platform sees it. */
interface Spoken {
  text: string
  lang: string
  rate: number
  onend: (() => void) | null
  onerror: (() => void) | null
}

interface Platform {
  spoken: Spoken[]
  cancels: number
}

/** Stands in for the operating system's voices, so the button can be driven in a test. */
function installPlatform(): Platform {
  const state: Platform = { spoken: [], cancels: 0 }
  class FakeUtterance {
    text: string
    lang = ''
    rate = 0
    onend: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(text: string) {
      this.text = text
      state.spoken.push(this as unknown as Spoken)
    }
  }
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: FakeUtterance, configurable: true })
  Object.defineProperty(window, 'speechSynthesis', {
    value: {
      speak: (): void => undefined,
      cancel: (): void => {
        state.cancels += 1
      }
    },
    configurable: true
  })
  return state
}

function removePlatform(): void {
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true })
  Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true })
}

const press = (): HTMLElement => screen.getByRole('button')

afterEach(() => {
  cleanup()
  removePlatform()
})

describe('SpeakButton', () => {
  it('draws nothing for a line that does not exist', () => {
    installPlatform()
    const { container } = render(<SpeakButton text="   " language="en" label="例句" />)

    expect(container.querySelector('.speak')).toBeNull()
  })

  it('says so instead of pretending when the machine has no voice', () => {
    removePlatform()
    render(<SpeakButton text="Hello" language="en" label="表达" />)

    const button = press() as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(button.getAttribute('title')).toBe('当前环境不支持语音')
  })

  it('reads its own line in the language being learned, and shows that it is playing', async () => {
    const platform = installPlatform()
    const user = userEvent.setup()
    render(<SpeakButton text="Bonjour" language={'fr' as LanguageCode} label="表达" />)

    await user.click(press())

    expect(platform.spoken).toHaveLength(1)
    expect(platform.spoken[0]?.lang).toBe('fr-FR')
    const button = press()
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(button.className).toContain('speak--on')
    // The name says what the press would do now, which is stop it.
    expect(button.getAttribute('aria-label')).toBe('停止朗读：表达')
  })

  it('stops when it is pressed a second time, so a line can be replayed', async () => {
    const platform = installPlatform()
    const user = userEvent.setup()
    render(<SpeakButton text="Hello" language="en" label="表达" />)

    await user.click(press())
    await user.click(press())

    expect(platform.cancels).toBeGreaterThanOrEqual(1)
    expect(press().getAttribute('aria-pressed')).toBe('false')
    expect(screen.getByLabelText('朗读：表达')).toBeDefined()
  })
})

