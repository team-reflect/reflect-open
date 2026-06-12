import { useEffect, useMemo, useRef } from 'react'
import { usePalette } from '@/components/command-palette/palette-provider'
import { registerKeymap } from '@/editor/keymap'
import { APP_COMMANDS } from '@/lib/commands/app-commands'
import { runCommand } from '@/lib/commands/registry'
import { retryFailedEmbeddings } from '@/lib/semantic'
import type { CommandContext } from '@/lib/commands/types'
import { useAudioMemo } from '@/providers/audio-memo-provider'
import { useGraph } from '@/providers/graph-provider'
import { useSettings } from '@/providers/settings-provider'
import { useShortcuts } from '@/providers/shortcuts-provider'
import { useSidebar } from '@/providers/sidebar-provider'
import { useTheme } from '@/providers/theme-provider'
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
 * returned context is also what the palette itself runs commands through.
 */
export function useAppShortcuts(): CommandContext {
  const { route, navigate, back, forward } = useRouter()
  const { resolvedTheme, setTheme } = useTheme()
  const { graph } = useGraph()
  const { openPalette, open: paletteOpen } = usePalette()
  const { openShortcuts, closeShortcuts, open: shortcutsOpen } = useShortcuts()
  const { toggleSidebar } = useSidebar()
  const { toggle: toggleAudioMemo } = useAudioMemo()
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

  const context = useMemo<CommandContext>(
    () => ({
      navigate,
      route: () => routeRef.current,
      back,
      forward,
      toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      toggleSidebar,
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
      toggleAudioMemo,
      updateSettings,
    ],
  )

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (paletteOpenRef.current) {
        return // modal palette owns the keyboard; Esc closes, then keys resume
      }
      if (!isModKey(event) || event.altKey || event.shiftKey || event.repeat) {
        return // held keys must not spam navigations (e.g. a stack of new notes)
      }
      const id = BINDING_TO_ID.get(`Mod-${event.key.toLowerCase()}`)
      if (shortcutsOpenRef.current) {
        // The cheat-sheet is modal too: nothing may navigate behind it, but
        // the key that opened it closes it again.
        if (id === 'shortcuts.show') {
          event.preventDefault()
          closeShortcuts()
        }
        return
      }
      if (id !== undefined) {
        event.preventDefault()
        void runCommand(id, context)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [context, closeShortcuts])

  return context
}
