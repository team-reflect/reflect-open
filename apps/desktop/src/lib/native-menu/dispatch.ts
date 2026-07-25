import { isTauri } from '@tauri-apps/api/core'
import { emitTo, type UnlistenFn } from '@tauri-apps/api/event'
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from '@tauri-apps/api/webviewWindow'
import { z } from 'zod'

/**
 * Native menu → command registry hand-off. The menu is built once at startup,
 * before React mounts, so item activations land here and are forwarded to
 * whichever mounted workspace currently owns the {@link import('@/lib/commands/types').CommandContext}.
 *
 * `useAppShortcuts` publishes its dispatcher on mount and clears it on
 * unmount. While no dispatcher is set (the moments before first mount, or
 * screens without a workspace) menu items are inert — there is nothing for a
 * command to act on, which is the same answer the keydown path gives there.
 */

type MenuCommandDispatch = (commandId: string) => void

let current: MenuCommandDispatch | null = null

const FocusedNoteMenuCommandSchema = z.enum([
  'note.find',
  'note.findNext',
  'note.findPrevious',
])

/** Native menu commands whose target is the focused note webview. */
export type FocusedNoteMenuCommand = z.infer<typeof FocusedNoteMenuCommandSchema>

const FOCUSED_NOTE_MENU_EVENT = 'reflect://focused-note-menu-command'

/** Publish (or with `null`, withdraw) the active menu-command dispatcher. */
export function setMenuCommandDispatch(dispatch: MenuCommandDispatch | null): void {
  current = dispatch
}

async function dispatchToFocusedWindow(commandId: FocusedNoteMenuCommand): Promise<void> {
  let focusedLabel: string | null = null
  try {
    const windows = await getAllWebviewWindows()
    const focusedWindows = await Promise.all(
      windows.map(async (window) => {
        try {
          return (await window.isFocused()) ? window : null
        } catch {
          // A window can close between enumeration and the focus check.
          return null
        }
      }),
    )
    const focusedWindow = focusedWindows.find((window) => window !== null)
    focusedLabel = focusedWindow?.label ?? null
  } catch (cause) {
    console.error('focused window lookup failed:', cause)
    return
  }

  if (focusedLabel === null) {
    // A menu activation can briefly leave macOS without a focused webview.
    // Never guess `main`: acting on the wrong note is worse than leaving this
    // one activation inert.
    return
  }

  if (focusedLabel !== 'main') {
    try {
      await emitTo(
        { kind: 'WebviewWindow', label: focusedLabel },
        FOCUSED_NOTE_MENU_EVENT,
        commandId,
      )
    } catch (cause) {
      // Never fall through to the main note: the command belongs to the
      // focused detached window, even if its event channel just disappeared.
      console.error('focused note menu dispatch failed:', cause)
    }
    return
  }
  current?.(commandId)
}

/**
 * Forward a native menu activation to the focused webview. Find commands are
 * note-window-local; all other commands retain the main workspace dispatcher.
 */
export function dispatchMenuCommand(commandId: string): void {
  const focusedNoteCommand = FocusedNoteMenuCommandSchema.safeParse(commandId)
  if (isTauri() && focusedNoteCommand.success) {
    void dispatchToFocusedWindow(focusedNoteCommand.data)
    return
  }
  current?.(commandId)
}

/** Listen for native Find menu commands routed to this focused note window. */
export async function listenForFocusedNoteMenuCommands(
  dispatch: (commandId: FocusedNoteMenuCommand) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) {
    return () => {}
  }
  return getCurrentWebviewWindow().listen<unknown>(
    FOCUSED_NOTE_MENU_EVENT,
    ({ payload }) => {
      const command = FocusedNoteMenuCommandSchema.safeParse(payload)
      if (command.success) {
        dispatch(command.data)
      }
    },
  )
}
