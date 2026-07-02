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
import { useNoteTemplates } from '@/providers/note-templates-provider'
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
const HISTORY_COMMAND_IDS = new Set(['history.back', 'history.forward'])

const CODE_TO_BINDING_KEY: Record<string, string> = {
  BracketLeft: '[',
  BracketRight: ']',
}

function isModKey(event: KeyboardEvent): boolean {
  return event.metaKey || event.ctrlKey
}

function bindingKeyFor(event: KeyboardEvent): string {
  const fromCode = CODE_TO_BINDING_KEY[event.code]
  if (fromCode !== undefined) {
    return fromCode
  }
  // Alt rewrites `event.key` on macOS (⌥L reports "Ò"), so alt chords match
  // letters and digits by physical code instead.
  if (event.altKey) {
    const code = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(event.code)
    if (code !== null) {
      return (code[1] ?? code[2] ?? '').toLowerCase()
    }
  }
  return event.key.toLowerCase()
}

function idForKeyDown(event: KeyboardEvent): string | null {
  if (!isModKey(event) || event.repeat) {
    return null // held keys must not spam navigations (e.g. a stack of new notes)
  }
  // Alt participates in the lookup rather than being rejected, so `Alt-Mod-l`
  // can bind while an alt chord still never fires a plain `Mod-` command.
  const alt = event.altKey ? 'Alt-' : ''
  const shift = event.shiftKey ? 'Shift-' : ''
  return BINDING_TO_ID.get(`${alt}Mod-${shift}${bindingKeyFor(event)}`) ?? null
}

/**
 * Install the app-level shortcut listener and build the {@link CommandContext}
 * commands run with. Mount once inside the router + palette providers; the
 * returned context is also what the palette itself runs commands through, and
 * the native menu's command items dispatch into the same guard path while
 * mounted (`setMenuCommandDispatch`).
 */
export function useAppShortcuts(): CommandContext {
  const { route, navigate, back, forward, clearScrollState } = useRouter()
  const focusedDailyDate = useFocusedDailyDate()
  const { resolvedTheme, setTheme } = useTheme()
  const { graph } = useGraph()
  const { openPalette, open: paletteOpen } = usePalette()
  const { openShortcuts, closeShortcuts, open: shortcutsOpen } = useShortcuts()
  const {
    openTemplatePicker,
    openTemplateCreate,
    pickerOpen: templatePickerOpen,
    createOpen: templateCreateOpen,
  } = useNoteTemplates()
  const { toggleSidebar } = useSidebar()
  const { toggle: toggleAudioMemo } = useAudioMemo()
  const { newChat } = useChatSession()
  const { updateSettings } = useSettings()

  // The palette is modal: app shortcuts must not navigate behind its overlay.
  // A ref keeps the listener stable across open/close renders.
  const paletteOpenRef = useRef(paletteOpen)

  // Same for the ⌘/ cheat-sheet, except ⌘/ itself toggles it closed.
  const shortcutsOpenRef = useRef(shortcutsOpen)

  // And for the template dialogs — both are Radix modals; nothing may
  // navigate behind them.
  const templatesOpenRef = useRef(templatePickerOpen || templateCreateOpen)

  // Read at run time, not captured: a command can fire long after the render
  // that created the context (palette open across an index rebuild, etc.).
  const generationRef = useRef<number | null>(graph?.generation ?? null)
  const routeRef = useRef(route)
  const focusedDailyDateRef = useRef(focusedDailyDate)
  useEffect(() => {
    paletteOpenRef.current = paletteOpen
    shortcutsOpenRef.current = shortcutsOpen
    templatesOpenRef.current = templatePickerOpen || templateCreateOpen
    generationRef.current = graph?.generation ?? null
    routeRef.current = route
    focusedDailyDateRef.current = focusedDailyDate
  })

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
      clearScrollState,
      toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      toggleSidebar,
      newChat,
      toggleAudioMemo,
      generation: () => generationRef.current,
      openPalette,
      openShortcuts,
      openTemplatePicker,
      openTemplateCreate,
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
      clearScrollState,
      resolvedTheme,
      setTheme,
      openPalette,
      openShortcuts,
      openTemplatePicker,
      openTemplateCreate,
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
      if (templatesOpenRef.current) {
        return false // the template picker/create dialogs are modal too
      }
      void runCommand(id, context)
      return true
    }

    function onHistoryKeyDownCapture(event: KeyboardEvent) {
      const id = idForKeyDown(event)
      if (id === null || !HISTORY_COMMAND_IDS.has(id)) {
        return
      }
      if (triggerCommand(id)) {
        // History navigation is app chrome, so it wins even when the focused
        // editor would otherwise consume the bracket chord while bubbling.
        event.preventDefault()
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) {
        // The focused editor gets first refusal. meowdown's `Mod-k` consumes the
        // keydown (preventDefault) only when it turns a selection or the link at
        // the caret into a link; the palette must not also open. When the editor
        // has nothing to do it leaves the event alone and `Mod-k` falls through.
        return
      }
      const id = idForKeyDown(event)
      if (id === null) {
        return
      }
      if (triggerCommand(id)) {
        // Also keeps the native menu's matching accelerator from firing the
        // same command again: the webview consumes the key equivalent.
        event.preventDefault()
      }
    }

    setMenuCommandDispatch(triggerCommand)
    window.addEventListener('keydown', onHistoryKeyDownCapture, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      setMenuCommandDispatch(null)
      window.removeEventListener('keydown', onHistoryKeyDownCapture, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [context, closeShortcuts])

  return context
}
