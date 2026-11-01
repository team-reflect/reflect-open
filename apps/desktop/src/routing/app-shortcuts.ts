import { useEffect, useMemo, useRef } from 'react'
import { getIsComposing } from '@meowdown/core'
import { usePalette } from '@/components/command-palette/palette-provider.tsx'
import { getIsoToday } from '@reflect/utils'
import type { CommandContext } from '@/lib/commands/types.ts'
import { useAudioMemo } from '@/providers/audio-memo-provider.tsx'
import { useMaybeChatSession } from '@/providers/chat-provider.tsx'
import { useFocusedDailyDate } from '@/providers/focused-daily-provider.tsx'
import { useGraph } from '@/providers/graph-provider.tsx'
import { useNoteFindActions } from '@/providers/note-find-provider.tsx'
import { useNoteTemplates } from '@/providers/note-templates-provider.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'
import { useShortcuts } from '@/providers/shortcuts-provider.tsx'
import { useSidebar } from '@/providers/sidebar-provider.tsx'
import { useTheme } from '@/providers/theme-provider.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { focusedNotePathForRoute } from '@reflect/app'
import { useRouter } from './router.tsx'

/**
 * App-scope keyboard shortcuts, driven by the command registry (Plan 08): a
 * binding and its behavior are one command definition — the switch statement
 * this file used to hold is gone. Bindings still register in the central
 * keymap registry, the shared collision ledger with editor-scope keys
 * (`registerAppKeymaps`).
 */

const HISTORY_COMMAND_IDS = new Set(['history.back', 'history.forward'])

// AppKit owns this key equivalent on macOS. Keep it in the registry for
// display, collision detection, and the plain-browser/non-macOS fallback, but
// do not consume its keydown in the webview before the native menu sees it.
const NATIVE_MACOS_MENU_COMMAND_IDS = new Set([
  'sidebar.toggle',
  'note.find',
  'note.findNext',
  'note.findPrevious',
])

/**
 * Install the app-level shortcut listener and build the {@link CommandContext}
 * commands run with. Mount once inside the router + palette providers; the
 * returned context is also what the palette itself runs commands through, and
 * the native menu's command items dispatch into the same guard path while
 * mounted (`setMenuCommandDispatch`).
 */

function doNothing(): void {}

export function useAppShortcuts(): CommandContext {
  const services = useCoreServices()
  const appServices = useAppServices()
  const { route, navigate, back, forward, clearScrollState } = useRouter()
  const { platform, semanticSearch } = services
  const { commands, nativeMenu } = appServices
  const focusedDailyDate = useFocusedDailyDate()
  const { resolvedTheme, setTheme } = useTheme()
  const { graph, recents, openRecent } = useGraph()
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
  // The hook can outlive the open graph, and its chat session with it.
  const newChat = useMaybeChatSession()?.newChat ?? doNothing
  const { updateSettings } = useSettings()
  const {
    openForPath: openNoteFindForPath,
    next: findNextInNote,
    previous: findPreviousInNote,
  } = useNoteFindActions()

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
  const graphRootRef = useRef<string | null>(graph?.root ?? null)
  const recentsRef = useRef(recents)
  const openRecentRef = useRef(openRecent)
  const routeRef = useRef(route)
  const focusedDailyDateRef = useRef(focusedDailyDate)
  useEffect(() => {
    paletteOpenRef.current = paletteOpen
    shortcutsOpenRef.current = shortcutsOpen
    templatesOpenRef.current = templatePickerOpen || templateCreateOpen
    graphRootRef.current = graph?.root ?? null
    recentsRef.current = recents
    openRecentRef.current = openRecent
    routeRef.current = route
    focusedDailyDateRef.current = focusedDailyDate
  })

  const context = useMemo<CommandContext>(
    () => ({
      services,
      app: appServices,
      navigate,
      route: () => routeRef.current,
      // Resolve through the focused stream day so a note-scoped command targets
      // the same day the context sidebar shows (see `effectiveDailyDate`); off
      // the daily views it falls back to the routed note.
      notePath: () => {
        return focusedNotePathForRoute(routeRef.current, getIsoToday(), focusedDailyDateRef.current)
      },
      togglePin: async () => {
        const path = focusedNotePathForRoute(
          routeRef.current,
          getIsoToday(),
          focusedDailyDateRef.current,
        )
        if (path !== null) {
          await services.noteActions.togglePinned(path)
        }
      },
      togglePrivate: async () => {
        const path = focusedNotePathForRoute(
          routeRef.current,
          getIsoToday(),
          focusedDailyDateRef.current,
        )
        if (path !== null) {
          await services.noteActions.togglePrivate(path)
        }
      },
      back,
      forward,
      clearScrollState,
      toggleTheme: () => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark'),
      toggleSidebar,
      newChat,
      openNoteFind: () => {
        openNoteFindForPath(
          focusedNotePathForRoute(routeRef.current, getIsoToday(), focusedDailyDateRef.current),
        )
      },
      findNextInNote,
      findPreviousInNote,
      switchGraph: (index) => {
        const recent = recentsRef.current[index]
        if (recent === undefined || recent.root === graphRootRef.current) {
          return
        }
        void openRecentRef.current(recent.root)
      },
      toggleAudioMemo,
      openPalette,
      openShortcuts,
      openTemplatePicker,
      openTemplateCreate,
      enableSemanticSearch: () => {
        updateSettings({ semanticSearchEnabled: true })
        // EmbeddingsSync loads an untouched runtime; a `failed` one only
        // retries on an explicit action like this command.
        void semanticSearch.retryFailedModel()
      },
    }),
    [
      services,
      appServices,
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
      openNoteFindForPath,
      findNextInNote,
      findPreviousInNote,
      toggleAudioMemo,
      updateSettings,
      semanticSearch,
    ],
  )

  useEffect(() => {
    function idForKeyDown(event: KeyboardEvent): string | null {
      return commands.commandForKeyDown(event)
    }

    function isNativeMacosMenuCommand(commandId: string): boolean {
      return (
        platform.isMacosDesktop &&
        nativeMenu.isInstalled() &&
        NATIVE_MACOS_MENU_COMMAND_IDS.has(commandId)
      )
    }

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
      void commands.run(id, context)
      return true
    }

    function onHistoryKeyDownCapture(event: KeyboardEvent) {
      if (getIsComposing()) {
        return
      }
      const id = idForKeyDown(event)
      if (id === null || isNativeMacosMenuCommand(id) || !HISTORY_COMMAND_IDS.has(id)) {
        return
      }
      if (triggerCommand(id)) {
        // History navigation is app chrome, so it wins even when the focused
        // editor would otherwise consume the bracket chord while bubbling.
        event.preventDefault()
      }
    }

    function onKeyDown(event: KeyboardEvent) {
      if (getIsComposing()) {
        return
      }
      if (event.defaultPrevented) {
        // The focused editor gets first refusal. meowdown's `Mod-k` consumes the
        // keydown (preventDefault) only when it turns a selection or the link at
        // the caret into a link; the palette must not also open. When the editor
        // has nothing to do it leaves the event alone and `Mod-k` falls through.
        return
      }
      const id = idForKeyDown(event)
      if (id === null || isNativeMacosMenuCommand(id)) {
        return
      }
      if (triggerCommand(id)) {
        // Also keeps the native menu's matching accelerator from firing the
        // same command again: the webview consumes the key equivalent.
        event.preventDefault()
      }
    }

    nativeMenu.setCommandDispatch(triggerCommand)
    window.addEventListener('keydown', onHistoryKeyDownCapture, { capture: true })
    window.addEventListener('keydown', onKeyDown)
    return () => {
      nativeMenu.setCommandDispatch(null)
      window.removeEventListener('keydown', onHistoryKeyDownCapture, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [context, closeShortcuts, commands, nativeMenu, platform])

  return context
}
