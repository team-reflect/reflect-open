import { isTauri } from '@tauri-apps/api/core'

/**
 * Whether the window draws content under a transparent macOS title bar
 * (`titleBarStyle: "Overlay"` in tauri.conf.json), with the traffic lights
 * floating over the top-left of the webview.
 *
 * True only in the macOS desktop webview: plain-browser dev and other
 * desktop platforms keep their native title bars, and iPadOS — whose user
 * agent masquerades as macOS — is excluded by the touch-point check.
 *
 * Layout that must clear the title-bar zone (the top 28px, `h-7`/`pt-7`)
 * keys off this; the zone itself is claimed by `WindowDragRegion`.
 */
export const hasMacosTitleBarOverlay: boolean =
  isTauri() &&
  typeof navigator !== 'undefined' &&
  navigator.userAgent.includes('Macintosh') &&
  navigator.maxTouchPoints === 0
