import type { ReactElement } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'

/**
 * Invisible strip standing in for the macOS title bar when it's overlaid
 * (`titleBarStyle: "Overlay"` in tauri.conf.json). Tauri's built-in
 * `data-tauri-drag-region` handler makes mousedown drag the window and
 * double-click toggle zoom, matching native title-bar behavior.
 *
 * Mouse events on the strip never reach content beneath it, so interactive
 * elements within its 28px height (`h-7`) must raise themselves with the
 * `window-drag-control` utility: the strip mounts before the app, so at equal
 * z-index the app's controls win by tree order, while same-z overlays mounted
 * later (the command palette) still cover those controls. Renders nothing
 * outside the macOS desktop webview, where the native title bar still exists.
 */
export function WindowDragRegion(): ReactElement | null {
  const { platform } = useCoreServices()
  if (!platform.hasMacosTitleBarOverlay) {
    return null
  }
  return <div aria-hidden data-tauri-drag-region className="fixed inset-x-0 top-0 z-40 h-7" />
}
