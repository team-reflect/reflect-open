import { isTauri } from '@tauri-apps/api/core'
import {
  Menu,
  Submenu,
  type MenuItemOptions,
  type PredefinedMenuItemOptions,
} from '@tauri-apps/api/menu'
import { APP_COMMANDS } from '@/lib/commands/app-commands'
import { bindingToAccelerator } from './accelerator'
import { dispatchMenuCommand } from './dispatch'

/**
 * The native macOS application menu (the V1 Electron menu, ported). Command
 * items derive from {@link APP_COMMANDS} — id, label, and accelerator come
 * from the one command definition, the same source the ⌘K palette and the ⌘/
 * cheat-sheet read — so the menu cannot drift from the bindings that fire.
 * Everything else is a predefined (native role) item.
 *
 * Activations route through `dispatchMenuCommand` into the same guarded
 * dispatch `useAppShortcuts` runs keydown bindings through, so menu clicks
 * respect the modal palette/cheat-sheet exactly like keystrokes do.
 */

type PredefinedItem = PredefinedMenuItemOptions['item']

export type AppMenuEntry =
  | { kind: 'command'; commandId: string; text?: string | undefined }
  | { kind: 'predefined'; item: PredefinedItem; text?: string | undefined }

export interface AppSubmenuLayout {
  text: string
  /**
   * macOS NSApp role: `windows` gains the automatic window list,
   * `help` gains the Search field.
   */
  nsAppRole?: 'windows' | 'help'
  entries: AppMenuEntry[]
}

function command(commandId: string, text?: string): AppMenuEntry {
  return { kind: 'command', commandId, text }
}

function predefined(item: PredefinedItem, text?: string): AppMenuEntry {
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

function menuItemOptions(commandId: string, text?: string): MenuItemOptions {
  const appCommand = APP_COMMANDS.find((candidate) => candidate.id === commandId)
  if (!appCommand) {
    throw new Error(`native menu references unknown command: ${commandId}`)
  }
  const accelerator = appCommand.keybinding ? bindingToAccelerator(appCommand.keybinding) : undefined
  return {
    id: appCommand.id,
    text: text ?? appCommand.title,
    ...(accelerator !== undefined ? { accelerator } : {}),
    action: dispatchMenuCommand,
  }
}

function entryOptions(entry: AppMenuEntry): MenuItemOptions | PredefinedMenuItemOptions {
  return entry.kind === 'command'
    ? menuItemOptions(entry.commandId, entry.text)
    : { item: entry.item, ...(entry.text !== undefined ? { text: entry.text } : {}) }
}

/**
 * True in the macOS desktop webview only — iPadOS masquerades as macOS in the
 * user agent and is excluded by the touch-point check (same test as
 * `lib/window-chrome.ts`).
 */
function isMacosDesktop(): boolean {
  return (
    isTauri() &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Macintosh') &&
    navigator.maxTouchPoints === 0
  )
}

/**
 * Build the application menu and install it, replacing Tauri's default.
 * Call once at startup, before React mounts — the menu holds command ids, not
 * state, so it never needs rebuilding.
 *
 * macOS-only for now: other desktop platforms would render an in-window
 * menubar we haven't designed for, and every shortcut already works there
 * through the keydown path. Keyboard equivalents the webview handles are
 * consumed before the menu sees them (`useAppShortcuts` prevents the default),
 * so a focused webview never double-fires a command.
 */
export async function installNativeMenu(): Promise<void> {
  if (!isMacosDesktop()) {
    return
  }
  const layouts = appMenuLayout()
  const submenus = await Promise.all(
    layouts.map((layout) =>
      Submenu.new({
        text: layout.text,
        items: layout.entries.map(entryOptions),
      }),
    ),
  )
  const menu = await Menu.new({ items: submenus })
  await menu.setAsAppMenu()
  // NSApp roles must be assigned after setAsAppMenu: attaching the menu
  // clones each submenu's NSMenu, and muda resolves the role against the
  // instance inside the installed main menu — assigned earlier, the role
  // silently no-ops and macOS never adds its automatic items (the window
  // list and Move & Resize/tiling with their system shortcuts; Help search).
  for (const [index, layout] of layouts.entries()) {
    const submenu = submenus[index]
    if (!submenu) {
      continue
    }
    if (layout.nsAppRole === 'windows') {
      await submenu.setAsWindowsMenuForNSApp()
    } else if (layout.nsAppRole === 'help') {
      await submenu.setAsHelpMenuForNSApp()
    }
  }
}
