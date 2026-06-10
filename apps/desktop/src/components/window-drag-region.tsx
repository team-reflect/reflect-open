import type { ReactElement } from 'react'
import { hasMacosTitleBarOverlay } from '@/lib/window-chrome'

/**
 * Invisible strip standing in for the macOS title bar when it's overlaid
 * (`titleBarStyle: "Overlay"` in tauri.conf.json). Tauri's built-in
 * `data-tauri-drag-region` handler makes mousedown drag the window and
 * double-click toggle zoom, matching native title-bar behavior.
 *
 * Mouse events on the strip never reach content beneath it, so interactive
 * elements must stay below its 28px height (`h-7` here, `pt-7` clearance in
 * the surfaces that need it — see `hasMacosTitleBarOverlay` call sites).
 * Renders nothing outside the macOS desktop webview, where the native title
 * bar still exists.
 */
export function WindowDragRegion(): ReactElement | null {
  if (!hasMacosTitleBarOverlay) {
    return null
  }
  return <div aria-hidden data-tauri-drag-region className="fixed inset-x-0 top-0 z-40 h-7" />
}
