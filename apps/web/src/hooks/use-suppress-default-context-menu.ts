import { useEffect } from 'react'

/**
 * The regions where the user edits or selects text. `styles/index.css` restores
 * text selection on the same regions, and `select-text` opts in elsewhere.
 */
const TEXT_REGION_SELECTOR =
  'input, textarea, [contenteditable], .reflect-editor, .reflect-chat-message, .reflect-protected-note, .select-text'

/**
 * Suppresses the webview's default context menu (Reload, Inspect Element)
 * outside text regions while `enabled` is true.
 */
export function useSuppressDefaultContextMenu(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) {
      return
    }
    const controller = new AbortController()
    document.addEventListener(
      'contextmenu',
      (event) => {
        if (!(event.target instanceof Element && event.target.closest(TEXT_REGION_SELECTOR))) {
          event.preventDefault()
        }
      },
      { signal: controller.signal },
    )
    return () => controller.abort()
  }, [enabled])
}
