import type { ChromeButton, ChromeIcon, ChromeMenuItem } from '@/mobile/chrome/screen-chrome.ts'
import type { NativeBarButton, NativeMenuItem } from '@/mobile/chrome/native/protocol.ts'

const SF_SYMBOLS: Record<ChromeIcon, string> = {
  settings: 'gearshape',
  plus: 'plus',
  history: 'clock.arrow.circlepath',
  ellipsis: 'ellipsis',
  pin: 'pin',
  'pin-off': 'pin.slash',
  lock: 'lock',
  'lock-open': 'lock.open',
  share: 'square.and.arrow.up',
  trash: 'trash',
}

function toWireMenuItem(item: ChromeMenuItem): NativeMenuItem {
  if (item.type === 'section') {
    return { ...item, items: item.items.map(toWireMenuItem) }
  }
  return { ...item, icon: item.icon === undefined ? undefined : SF_SYMBOLS[item.icon] }
}

/**
 * A menu as the shell draws it: SF Symbol icons.
 */
export function toWireMenu(items: ChromeMenuItem[]): NativeMenuItem[] {
  return items.map(toWireMenuItem)
}

/**
 * The buttons as the shell draws them: SF Symbol icons, and no hidden button.
 */
export function toWireButtons(buttons: ChromeButton[]): NativeBarButton[] {
  return buttons
    .filter((button) => button.hidden !== true)
    .map(({ hidden: _hidden, ...button }) => ({
      ...button,
      icon: button.icon === undefined ? undefined : SF_SYMBOLS[button.icon],
      menu: button.menu === undefined ? undefined : toWireMenu(button.menu),
    }))
}
