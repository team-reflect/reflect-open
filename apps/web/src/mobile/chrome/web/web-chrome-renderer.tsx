import type { CSSProperties, ReactElement } from 'react'
import { noop } from '@ocavue/utils'
import type { ChromeRenderer, ShellBarsProps } from '@/mobile/chrome/chrome-renderer.ts'
import { MobileFormattingToolbar } from '@/mobile/formatting-toolbar.tsx'
import { MobileTabBar } from '@/mobile/mobile-tab-bar.tsx'

/**
 * The tab bar, or the formatting toolbar while the keyboard is up. V1 lets
 * the keyboard cover the tab bar; the shell root ends at the keyboard's top,
 * so the bar would ride above the keyboard instead, and it hides while
 * typing. The toolbar takes its slot at the bottom of the root, exactly on
 * the keyboard edge with no fixed positioning.
 */
function WebShellBars({ tab, onSelectTab, keyboardVisible }: ShellBarsProps): ReactElement {
  return keyboardVisible ? (
    <MobileFormattingToolbar />
  ) : (
    <MobileTabBar tab={tab} onSelect={onSelectTab} />
  )
}

function NoChrome(): null {
  return null
}

/**
 * The chrome the web page draws itself.
 */
export const WEB_CHROME_RENDERER: ChromeRenderer = {
  ShellBars: WebShellBars,
  NoChrome,
  // The tab bar's height above the bottom safe area, which it pads itself.
  shellStyle: {
    '--chrome-bottom-bar': 'calc(var(--spacing) * 13)',
    '--chrome-safe-bottom': '0px',
  } as CSSProperties,
  registerScreen: () => noop,
  updateScreen: noop,
  openModal: () => noop,
  reportStackMotion: noop,
}
