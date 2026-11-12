import { useScreenChrome } from '@/mobile/chrome/chrome-renderer.ts'
import type { ChromeButton } from '@/mobile/chrome/screen-chrome.ts'

/**
 * The native corner buttons of one screen. The screen draws its own title.
 */
export interface NativeBarSpec {
  leading?: ChromeButton[] | undefined
  trailing?: ChromeButton[] | undefined
}

/**
 * The handlers behind one screen's bar. `onBack` replaces the router's back.
 */
export interface NativeBarHandlers {
  onAction: (id: string) => void
  onBack?: (() => void) | undefined
}

/**
 * Register this screen's bar for the history entry it shows.
 */
export function useNativeBar(spec: NativeBarSpec, handlers: NativeBarHandlers): void {
  useScreenChrome({
    leading: spec.leading,
    trailing: spec.trailing,
    back: handlers.onBack,
    onAction: handlers.onAction,
  })
}
