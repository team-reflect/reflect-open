import type {
  AppMenuEntry,
  AppSubmenuLayout,
  NativeMenuPredefinedItem,
  NativeMenuService,
} from '@reflect/app'
import type { PlatformFacts } from '@reflect/core'

/**
 * The native macOS application menu (the V1 Electron menu, ported). Command
 * items derive from the command registry — id, label, and accelerator come
 * from the one command definition, the same source the ⌘K palette and the ⌘/
 * cheat-sheet read — so the menu cannot drift from the bindings that fire.
 * Everything else is a predefined (native role) item.
 *
 * Activations route through `dispatchMenuCommand` into the same guarded
 * dispatch `useAppShortcuts` runs keydown bindings through, so menu clicks
 * respect the modal palette/cheat-sheet exactly like keystrokes do.
 */

function command(commandId: string, text?: string): AppMenuEntry {
  return { kind: 'command', commandId, text }
}

function predefined(item: NativeMenuPredefinedItem, text?: string): AppMenuEntry {
  return { kind: 'predefined', item, text }
}

function separator(): AppMenuEntry {
  return predefined('Separator')
}

export interface AppMenuLayoutOptions {
  /**
   * The iPadOS menu bar: it has no note window to open a note in (yet) and no
   * in-app web inspector, so those commands stay off it.
   */
  readonly tablet?: boolean
}

/**
 * The menu structure, as pure data so tests can hold it against the command
 * registry. macOS replaces the first submenu's title with the app name; the
 * iPad files each submenu into the system menu of the same title.
 */
export function appMenuLayout({ tablet = false }: AppMenuLayoutOptions = {}): AppSubmenuLayout[] {
  return [
    {
      text: 'Reflect',
      entries: [
        predefined({ About: null }, 'About Reflect'),
        separator(),
        command('settings.open', 'Settings…'),
        separator(),
        predefined('Services'),
        separator(),
        predefined('Hide', 'Hide Reflect'),
        predefined('HideOthers'),
        predefined('ShowAll'),
        separator(),
        predefined('Quit', 'Quit Reflect'),
      ],
    },
    {
      text: 'File',
      entries: [
        command('note.new'),
        command('note.attachFile'),
        separator(),
        predefined('CloseWindow'),
      ],
    },
    {
      text: 'Edit',
      entries: [
        predefined('Undo'),
        predefined('Redo'),
        separator(),
        predefined('Cut'),
        predefined('Copy'),
        predefined('Paste'),
        predefined('SelectAll'),
        separator(),
        command('note.find'),
        command('note.findNext'),
        command('note.findPrevious'),
      ],
    },
    {
      text: 'View',
      entries: [
        command('palette.open'),
        command('nav.today'),
        command('nav.allNotes'),
        command('chat.open'),
        separator(),
        command('history.back'),
        command('history.forward'),
        separator(),
        command('sidebar.toggle'),
        ...(tablet ? [] : [separator(), command('dev.toggleDevtools')]),
      ],
    },
    {
      text: 'Window',
      nsAppRole: 'windows',
      entries: [
        ...(tablet ? [] : [command('note.openInNewWindow'), separator()]),
        predefined('Minimize'),
        predefined('Maximize', 'Zoom'),
        separator(),
        predefined('BringAllToFront'),
      ],
    },
    {
      text: 'Help',
      nsAppRole: 'help',
      entries: [command('shortcuts.show')],
    },
  ]
}

/**
 * Build the application menu and install it, replacing Tauri's default.
 * Call once at startup, before React mounts — the menu holds command ids, not
 * state, so it never needs rebuilding.
 *
 * The macOS app menu and the iPadOS menu bar only: other desktop platforms
 * would render an in-window menubar we haven't designed for, and every
 * shortcut already works there through the keydown path. On macOS most
 * keyboard equivalents the webview handles are consumed before the menu sees
 * them (`useAppShortcuts` prevents the default), so a focused webview never
 * double-fires a command; the sidebar toggle is deliberately exempted there so
 * its key equivalent belongs to this native menu. On iPadOS the order is the
 * other way round: the menu bar claims its key equivalents first, and they run
 * through the same guarded dispatch.
 */
export async function installNativeMenu(
  nativeMenu: NativeMenuService,
  platform: Pick<PlatformFacts, 'isTablet'>,
): Promise<void> {
  await nativeMenu.install(appMenuLayout({ tablet: platform.isTablet }))
}
