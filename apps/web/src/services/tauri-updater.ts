import { relaunch } from '@tauri-apps/plugin-process'
import { check } from '@tauri-apps/plugin-updater'
import type { AvailableUpdate, UpdaterAdapter } from '@reflect/app'

/**
 * The Tauri updater and process plugins. Both are registered only under
 * `#[cfg(desktop)]`, so use this adapter only in the desktop native shell.
 */
export function createTauriUpdaterAdapter(): UpdaterAdapter {
  return {
    check: (): Promise<AvailableUpdate | null> => check(),
    relaunch: () => relaunch(),
  }
}
