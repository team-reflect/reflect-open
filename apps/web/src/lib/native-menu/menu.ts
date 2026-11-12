import type {
  AppMenuEntry,
  AppSubmenuLayout,
  NativeMenuPredefinedItem,
  NativeMenuService,
} from '@reflect/app'

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

/**
 * The menu structure, as pure data so tests can hold it against the command
 * registry. macOS replaces the first submenu's title with the app name.
 */
export function appMenuLayout(): AppSubmenuLayout[] {
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
        separator(),
        command('dev.toggleDevtools'),
      ],
    },
    {
      text: 'Window',
      nsAppRole: 'windows',
      entries: [
        command('note.openInNewWindow'),
        separator(),
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
 * macOS-only for now: other desktop platforms would render an in-window
 * menubar we haven't designed for, and every shortcut already works there
 * through the keydown path. Most keyboard equivalents the webview handles are
 * consumed before the menu sees them (`useAppShortcuts` prevents the default),
 * so a focused webview never double-fires a command. The sidebar toggle is
 * deliberately exempted there so its key equivalent belongs to this native
 * macOS application menu.
 */
export async function installNativeMenu(nativeMenu: NativeMenuService): Promise<void> {
  await nativeMenu.install(appMenuLayout())
}
