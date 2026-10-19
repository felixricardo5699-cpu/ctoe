import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { DEFAULT_LEARNING_LANGUAGE, DEFAULT_NATIVE_LANGUAGE } from '@shared/language/registry'
import type { LanguagePairKey } from '@shared/language/pair'
import type { BridgeLearnEvent } from '@shared/types/bridge'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FloatingBall } from './components/FloatingBall'
import { useSettings } from './hooks/useSettings'
import { useWindowMode } from './hooks/useWindowMode'
import { AssistantPage } from './pages/AssistantPage'
import { BridgeSentencePage } from './pages/BridgeSentencePage'
import { MyLanguagePage } from './pages/MyLanguagePage'
import { RecentTranslationsPage } from './pages/RecentTranslationsPage'
import { SettingsPage } from './pages/SettingsPage'
import { assistantApi } from './services/assistantApi'

type Page = 'assistant' | 'settings' | 'language' | 'recent' | 'bridge'

/**
 * One renderer, two shapes. The window is the same object all the time, so collapsing
 * to the ball never loses an in-flight translation.
 */
export function App(): ReactElement {
  const windowMode = useWindowMode()
  const [page, setPage] = useState<Page>('assistant')
  // The shelf My Learning should open on, when the user got there from a sentence elsewhere.
  const [languageFocus, setLanguageFocus] = useState<LanguagePairKey | null>(null)
  // The sentence a browser asked for. It is a receipt, and it is why this page exists: the app
  // learned something the user asked for from another program, so it says so rather than
  // switching screens as if nothing had happened.
  const [bridgeEvent, setBridgeEvent] = useState<BridgeLearnEvent | null>(null)
  const { settings, saving, errorMessage, save } = useSettings()

  const openSettings = useCallback((): void => setPage('settings'), [])
  const openLanguage = useCallback((): void => {
    setLanguageFocus(null)
    setPage('language')
  }, [])
  const openLanguagePair = useCallback((pair: LanguagePairKey): void => {
    setLanguageFocus(pair)
    setPage('language')
  }, [])
  const openRecent = useCallback((): void => setPage('recent'), [])
  const backToAssistant = useCallback((): void => setPage('assistant'), [])

  // The tray menu can ask for the settings page even while the ball is showing, so this
  // listener lives above the view switch.
  useEffect(() => {
    try {
      return assistantApi().onOpenSettings(openSettings)
    } catch {
      return undefined
    }
  }, [openSettings])

  // A sentence filed for a browser arrives while the user is doing something else - often while
  // they are looking at the web page, with the panel collapsed to the ball. The main process
  // brings the panel forward; showing the receipt is what this does, and it is the difference
  // between a background write and something the user can see happened.
  useEffect(() => {
    try {
      return assistantApi().onLearnSentence((event) => {
        setBridgeEvent(event)
        setPage('bridge')
      })
    } catch {
      return undefined
    }
  }, [])

  if (windowMode.mode === 'ball') {
    return (
      <ErrorBoundary>
        <FloatingBall />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div className="panel-frame" data-anchor={windowMode.anchor}>
        {page === 'assistant' ? (
          <AssistantPage
            settings={settings}
            onSaveSettings={save}
            onOpenSettings={openSettings}
            onOpenLanguage={openLanguage}
            onOpenRecent={openRecent}
          />
        ) : page === 'language' ? (
          <MyLanguagePage
            floatingBall={settings?.floatingBall ?? true}
            shortcut={settings?.globalShortcut}
            focusPair={languageFocus}
            onBack={backToAssistant}
          />
        ) : page === 'bridge' && bridgeEvent !== null ? (
          <BridgeSentencePage
            floatingBall={settings?.floatingBall ?? true}
            shortcut={settings?.globalShortcut}
            event={bridgeEvent}
            onOpenLanguage={openLanguagePair}
            onBack={backToAssistant}
          />
        ) : page === 'recent' ? (
          <RecentTranslationsPage
            floatingBall={settings?.floatingBall ?? true}
            shortcut={settings?.globalShortcut}
            enabled={settings?.recentPolicy === 'on'}
            profile={{
              nativeLanguage: settings?.nativeLanguage ?? DEFAULT_NATIVE_LANGUAGE,
              learningLanguage: settings?.learningLanguage ?? DEFAULT_LEARNING_LANGUAGE
            }}
            onOpenLanguage={openLanguagePair}
            onBack={backToAssistant}
          />
        ) : (
          <SettingsPage
            settings={settings}
            saving={saving}
            errorMessage={errorMessage}
            onSave={save}
            onBack={backToAssistant}
          />
        )}
      </div>
    </ErrorBoundary>
  )
}
