import { app } from 'electron'

/**
 * "Start with Windows" is delegated to the OS login items (the Run registry key on
 * Windows) instead of installing any extra dependency.
 *
 * In development the running binary is electron.exe with the project folder as an
 * argument, so registering it would leave a broken entry behind - only a packaged
 * build is allowed to touch the login items.
 */
export function applyLaunchAtLogin(enabled: boolean): boolean {
  if (!app.isPackaged) return false
  try {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [] })
    return true
  } catch {
    return false
  }
}
