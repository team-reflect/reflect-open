import { useEffect } from 'react'

/**
 * Return focus to whatever opened the current surface when it unmounts.
 *
 * Our dialogs are conditionally mounted by their parents (not kept alive
 * with `open=false`), so Radix's Presence/onCloseAutoFocus path is bypassed
 * when a success handler calls `onClose()` directly. Capturing the opener at
 * mount and focusing it from the cleanup covers every close path.
 */
export function useRestoreFocus(): void {
  useEffect(() => {
    const opener = document.activeElement
    return () => {
      if (opener instanceof HTMLElement) {
        opener.focus()
      }
    }
  }, [])
}
