import { useEffect, useMemo, useRef } from 'react'
import { dailyPath } from '@reflect/core'
import { usePalette } from '@/components/command-palette/palette-provider'
import { registerKeymap } from '@/editor/keymap'
import { APP_COMMANDS } from '@/lib/commands/app-commands'
import { runCommand } from '@/lib/commands/registry'
import { todayIso } from '@/lib/dates'
import { setMenuCommandDispatch } from '@/lib/native-menu/dispatch'
import { retryFailedEmbeddings } from '@/lib/semantic'
import type { CommandContext } from '@/lib/commands/types'
import { useAudioMemo } from '@/providers/audio-memo-provider'
import { useChatSession } from '@/providers/chat-provider'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import { useShortcuts } from '@/providers/shortcuts-provider'
import { useSidebar } from '@/providers/sidebar-provider'
import { useTheme } from '@/providers/theme-provider'
import { effectiveDailyDate, notePathForRoute } from './route'
import { useRouter } from './router'

/**
 * App-scope keyboard shortcuts, driven by the command registry (Plan 08): a
 * binding and its behavior are one command definition — the switch statement
 * this file used to hold is gone. Bindings still register through the central
 * keymap registry, the shared collision ledger with editor-scope keys.
 */

const BOUND_COMMANDS = APP_COMMANDS.flatMap((command) =>
  command.keybinding ? [{ binding: command.keybinding, command }] : [],
)

/** Registered once at module scope; values are display descriptions. */
export const APP_BINDINGS = registerKeymap(
  'app',
  Object.fromEntries(BOUND_COMMANDS.map(({ binding, command }) => [binding, command.title])),
)

const BINDING_TO_ID = new Map(BOUND_COMMANDS.map(({ binding, command }) => [binding, command.id]))

function isModKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}

/**
 * Install the app-level shortcut listener and build the {@link CommandContext}
 * commands run with. Mount once inside the router + palette providers; the
 * returned context is also what the palette itself runs commands through, and
 * the native menu's command items dispatch into the same guard path while
 * mounted (`setMenuCommandDispatch`).
 */
export function useAppShortcuts(): CommandContext {
  const { route, navigate, back, forward } = useRouter()
  const focusedDailyDate = useFocusedDailyDate()
  const { resolvedTheme, setTheme } = useTheme()
  const { graph } = useGraph()
  const { openPalette, open: paletteOpen } = usePalette()
  const { openShortcuts, closeShortcuts, open: shortcutsOpen } = useShortcuts()
  const { toggleSidebar } = useSidebar()
  const { toggle: toggleAudioMemo } = useAudioMemo()
  const { newChat } = useChatSession()
  const { updateSettings } = useSettings()

  // The palette is modal: app shortcuts must not navigate behind its overlay.
  // A ref keeps the listener stable across open/close renders.
  const paletteOpenRef = useRef(paletteOpen)
  paletteOpenRef.current = paletteOpen

  // Same for the ⌘/ cheat-sheet, except ⌘/ itself toggles it closed.
  const shortcutsOpenRef = useRef(shortcutsOpen)
  shortcutsOpenRef.current = shortcutsOpen

  // Read at run time, not captured: a command can fire long after the render
  // that created the context (palette open across an index rebuild, etc.).
  const generationRef = useRef<number | null>(graph?.generation ?? null)
  generationRef.current = graph?.generation ?? null
  const routeRef = useRef(route)
  routeRef.current = route
  const focusedDailyDateRef = useRef(focusedDailyDate)
  focusedDailyDateRef.current = focusedDailyDate

  const context = useMemo<CommandContext>(
    () => ({
      navigate,
      route: () => routeRef.current,
      // Resolve through the focused stream day so a note-scoped command targets
      // the same day the context sidebar shows (see `effectiveDailyDate`); off
      // the daily views it falls back to the routed note.
      notePath: () => {
        const route = routeRef.current
        const today = todayIso()
        const daily = effectiveDailyDate(route, today, focusedDailyDateRef.current)
        return daily !== null ? dailyPath(daily) : notePathForRoute(route, today)
      },
      back,
      forward,
      toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      toggleSidebar,
      newChat,
      toggleAudioMemo,
      generation: () => generationRef.current,
      openPalette,
      openShortcuts,
      enableSemanticSearch: () => {
        updateSettings({ semanticSearchEnabled: true })
        // EmbeddingsSync loads an untouched runtime; a `failed` one only
        // retries on an explicit action like this command.
        void retryFailedEmbeddings()
      },
    }),
    [
      navigate,
      back,
      forward,
      resolvedTheme,
      setTheme,
      openPalette,
      openShortcuts,
      toggleSidebar,
      newChat,
      toggleAudioMemo,
      updateSettings,
    ],
  )

  useEffect(() => {
    // The one guarded entry point for app commands, shared by keystrokes and
    // native menu activations. Returns whether the command was handled.
    function triggerCommand(id: string): boolean {
      if (paletteOpenRef.current) {
        return false // modal palette owns the screen; Esc closes, then commands resume
      }
      if (shortcutsOpenRef.current) {
        // The cheat-sheet is modal too: nothing may navigate behind it, but
        // the command that opened it closes it again.
        if (id === 'shortcuts.show') {
          closeShortcuts()
          return true
        }
        return false
      }
      void runCommand(id, context)
      return true
    }

    function onKeyDown(event: KeyboardEvent) {
      if (!isModKey(event) || event.altKey || event.repeat) {
        return // held keys must not spam navigations (e.g. a stack of new notes)
      }
      const bindingKey = event.shiftKey
        ? `Mod-Shift-${event.key.toLowerCase()}`
        : `Mod-${event.key.toLowerCase()}`
      const id = BINDING_TO_ID.get(bindingKey)
      if (id === undefined) {
        return
      }
      if (triggerCommand(id)) {
        // Also keeps the native menu's matching accelerator from firing the
        // same command again: the webview consumes the key equivalent.
        event.preventDefault()
      }
    }

    setMenuCommandDispatch(triggerCommand)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      setMenuCommandDispatch(null)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [context, closeShortcuts])

  return context
}
