import { noop } from '@ocavue/utils'
import type { ChromeRenderer } from '@/mobile/chrome/chrome-renderer.ts'

function NoBars(): null {
  return null
}

/**
 * The chrome the web page draws itself.
 */
export const WEB_CHROME_RENDERER: ChromeRenderer = {
  ShellBars: NoBars,
  NoChrome: NoBars,
  registerScreen: () => noop,
  updateScreen: noop,
  openModal: () => noop,
  reportStackMotion: noop,
}
