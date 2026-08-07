import { isTauri } from '@tauri-apps/api/core'

/**
 * True in a real Tauri webview — plugins, custom URL schemes, and real OS
 * windows are reachable. NOT satisfied by the in-browser dev bridge, which
 * answers IPC commands (`hasBridge()`) without any of those. Gates that mean
 * "the native shell exists" use this; gates that mean "commands can be
 * answered" use `hasBridge()`.
 */
export function isNativeShell(): boolean {
  return isTauri()
}

/**
 * True in the macOS desktop webview — the platform gate for macOS-only
 * capabilities (EventKit calendar access). Plain-browser dev and other
 * desktop platforms are excluded by the Tauri check; iPadOS — whose user
 * agent masquerades as macOS — by the touch-point check (the same rule as
 * `window-chrome.ts`'s title-bar probe).
 */
export const isMacosDesktop: boolean =
  isTauri() &&
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  navigator.maxTouchPoints === 0
