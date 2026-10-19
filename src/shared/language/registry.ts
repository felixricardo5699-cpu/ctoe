/*
 * The one place that knows which languages this app supports.
 *
 * Prompts, settings, stored records, UI labels and text direction all read from here, so
 * adding a language is a data change instead of a hunt for a hardcoded 'Chinese'. The module
 * imports nothing on purpose: every layer, including the renderer, can use it safely.
 *
 * Two roles are all the app needs: the language the user speaks (native) and the one they are
 * learning. Direction is decided from those two plus the mode, never from the text.
 */

/** Primary subtags, which is all the app needs to tell two languages apart. */
export type LanguageCode = 'en' | 'zh' | 'fr' | 'es' | 'ru' | 'ar'

/** Writing direction. Arabic is the reason this exists; nothing else in v1 is RTL. */
export type TextDirection = 'ltr' | 'rtl'

export interface Language {
  code: LanguageCode
  /** English name. Prompts use this one: models follow 'into French' far more reliably. */
  name: string
  /** Endonym, for the pickers - people look for their own language under its own name. */
  nativeName: string
  /**
   * BCP-47 tag for read-aloud. Voices are matched per region ('fr-FR', not 'fr'), so the
   * tag is language data like the rest of this file: adding a language means giving it a
   * voice here rather than teaching the speech layer a second list of languages.
   */
  speechTag: string
  direction: TextDirection
  /** false keeps a language in the registry but out of the pickers. */
  enabled: boolean
}

/** The UN official languages, which is the v1 scope. */
export const LANGUAGES: readonly Language[] = [
  { code: 'en', name: 'English', nativeName: 'English', speechTag: 'en-US', direction: 'ltr', enabled: true },
  { code: 'zh', name: 'Chinese', nativeName: '中文', speechTag: 'zh-CN', direction: 'ltr', enabled: true },
  { code: 'fr', name: 'French', nativeName: 'Français', speechTag: 'fr-FR', direction: 'ltr', enabled: true },
  { code: 'es', name: 'Spanish', nativeName: 'Español', speechTag: 'es-ES', direction: 'ltr', enabled: true },
  { code: 'ru', name: 'Russian', nativeName: 'Русский', speechTag: 'ru-RU', direction: 'ltr', enabled: true },
  { code: 'ar', name: 'Arabic', nativeName: 'العربية', speechTag: 'ar-SA', direction: 'rtl', enabled: true }
]

/** Everything the user can pick today. A disabled language stays readable but unselectable. */
export const SUPPORTED_LANGUAGES: readonly Language[] = LANGUAGES.filter((language) => language.enabled)

export const LANGUAGE_CODES: readonly LanguageCode[] = LANGUAGES.map((language) => language.code)

/**
 * The product starts as Chinese -> English, but nothing below assumes that pair: these two
 * are only the fallbacks used when a stored value is missing or unreadable.
 */
export const DEFAULT_NATIVE_LANGUAGE: LanguageCode = 'zh'
export const DEFAULT_LEARNING_LANGUAGE: LanguageCode = 'en'

export function isLanguageCode(value: unknown): value is LanguageCode {
  return typeof value === 'string' && LANGUAGES.some((language) => language.code === value)
}

export function findLanguage(code: string): Language | null {
  return LANGUAGES.find((language) => language.code === code) ?? null
}

/** Trust boundary helper: an unreadable value falls back instead of throwing. */
export function resolveLanguageCode(value: unknown, fallback: LanguageCode): LanguageCode {
  return isLanguageCode(value) ? value : fallback
}

export function languageName(code: LanguageCode): string {
  return findLanguage(code)?.name ?? code
}

export function languageNativeName(code: LanguageCode): string {
  return findLanguage(code)?.nativeName ?? code
}

export function textDirection(code: LanguageCode): TextDirection {
  return findLanguage(code)?.direction ?? 'ltr'
}

/** Tag handed to the speech engine; an unknown language falls back to its own code. */
export function speechTag(code: LanguageCode): string {
  return findLanguage(code)?.speechTag ?? code
}
