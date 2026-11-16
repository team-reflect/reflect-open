import { useLayoutEffect } from 'react'
import { setBottomScrollInset } from '@/editor/bottom-scroll-inset.ts'
import { useFormattingToolbar } from '@/editor/formatting-toolbar-store.ts'
import { useStore } from '@/lib/use-store.ts'
import { useAppServices } from '@/services/services-provider.tsx'

/**
 * The view that the iOS shell puts above the software keyboard while an
 * editor has focus (`FormattingAccessory.swift`). The shell declares it at
 * document start.
 */
interface KeyboardAccessory {
  /**
   * The height of the view, in CSS pixels.
   */
  height: number
  /**
   * The tallest keyboard, without the view, that shows no view: the shortcut
   * bar of a hardware keyboard.
   */
  shortcutBarHeight: number
}

declare global {
  interface Window {
    __reflectKeyboardAccessory?: KeyboardAccessory | undefined
  }
}

/**
 * The height of the keyboard overlap that the accessory view takes, by the
 * same rule as the iOS shell: the view shows while an editor has focus and
 * the keyboard is taller than the shortcut bar.
 */
export function getKeyboardAccessoryOverlap(
  keyboardHeight: number,
  editorFocused: boolean,
): number {
  const accessory = window.__reflectKeyboardAccessory
  if (!accessory || !editorFocused) {
    return 0
  }
  return keyboardHeight - accessory.height > accessory.shortcutBarHeight ? accessory.height : 0
}

/**
 * Mirrors the accessory view's overlap into `--keyboard-accessory-overlap` on
 * the document root and into the editor's bottom scroll inset. The
 * mobile shell root extends under the view by this height, so the page shows
 * through the view.
 */
export function useKeyboardAccessoryVar(): void {
  const { keyboard } = useAppServices()
  const keyboardHeight = useStore(keyboard)
  const editorFocused = useFormattingToolbar() !== null
  const overlap = getKeyboardAccessoryOverlap(keyboardHeight, editorFocused)
  useLayoutEffect(() => {
    setBottomScrollInset(overlap)
    document.documentElement.style.setProperty('--keyboard-accessory-overlap', `${overlap}px`)
    return () => {
      setBottomScrollInset(0)
      document.documentElement.style.removeProperty('--keyboard-accessory-overlap')
    }
  }, [overlap])
}
