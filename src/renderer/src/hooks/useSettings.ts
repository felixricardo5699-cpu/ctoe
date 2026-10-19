import { useCallback, useEffect, useState } from 'react'
import type { PublicSettings, SettingsPatch } from '@shared/types'
import { assistantApi } from '../services/assistantApi'

export interface UseSettingsResult {
  settings: PublicSettings | null
  saving: boolean
  errorMessage: string | null
  save(patch: SettingsPatch): Promise<void>
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<PublicSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    assistantApi()
      .getSettings()
      .then((loaded) => {
        if (!cancelled) setSettings(loaded)
      })
      .catch(() => {
        if (!cancelled) setErrorMessage('无法读取本地设置。')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const save = useCallback(async (patch: SettingsPatch): Promise<void> => {
    setSaving(true)
    setErrorMessage(null)
    try {
      setSettings(await assistantApi().saveSettings(patch))
    } catch {
      setErrorMessage('保存设置失败，请重试。')
    } finally {
      setSaving(false)
    }
  }, [])

  return { settings, saving, errorMessage, save }
}
