import { useEffect } from 'react'

/**
 * The regions where the user edits or selects text. `styles/index.css` restores
 * text selection on the same regions.
 */
const TEXT_REGION_SELECTOR =
  'input, textarea, [contenteditable], .reflect-editor, .reflect-chat-message, .reflect-protected-note'

/**
 * Returns whether a right-click on `target` keeps the webview's default context
 * menu: inside a text region, so Copy, Paste and spelling stay available.
 */
export function keepsDefaultContextMenu(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(TEXT_REGION_SELECTOR) !== null
}

/**
 * Suppresses the webview's default context menu (Reload, Inspect Element)
 * outside text regions. Development builds keep it everywhere.
 */
export function useSuppressDefaultContextMenu(): void {
  useEffect(() => {
    if (import.meta.env.DEV) {
      return
    }
    const controller = new AbortController()
    document.addEventListener(
      'contextmenu',
      (event) => {
        if (!keepsDefaultContextMenu(event.target)) {
          event.preventDefault()
        }
      },
      { signal: controller.signal },
    )
    return () => controller.abort()
  }, [])
}
