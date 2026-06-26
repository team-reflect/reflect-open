import { isTauri } from '@tauri-apps/api/core'
import { Menu } from '@tauri-apps/api/menu'

let activeUnpin: (() => void) | null = null
let pinnedNoteContextMenu: Promise<Menu> | null = null

function getPinnedNoteContextMenu(): Promise<Menu> {
  pinnedNoteContextMenu ??= Menu.new({
    items: [
      {
        text: 'Unpin Note',
        action: () => {
          activeUnpin?.()
        },
      },
    ],
  })
  return pinnedNoteContextMenu
}

/**
 * Open the native Tauri context menu for one row in the pinned-note shelf.
 * Outside Tauri, this is a no-op so browser/test shells can ignore it.
 */
export async function openPinnedNoteContextMenu(onUnpin: () => void): Promise<void> {
  if (!isTauri()) {
    return
  }

  activeUnpin = onUnpin
  await (await getPinnedNoteContextMenu()).popup()
}
