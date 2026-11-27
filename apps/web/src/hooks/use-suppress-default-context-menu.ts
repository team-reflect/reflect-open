import { useEffect } from 'react'

/**
 * Mirrors the selectable regions in `styles/index.css`, plus `select-text`.
 */
const TEXT_REGION_SELECTOR =
  'input, textarea, [contenteditable], .reflect-editor, .reflect-chat-message, .reflect-protected-note, .select-text'

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
