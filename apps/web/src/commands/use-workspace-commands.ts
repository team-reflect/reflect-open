import {
  enableSemanticSearch,
  newNoteRoute,
  switchToRecentGraph,
  type AppCommandId,
  type GraphSwitchPosition,
} from '@reflect/app'
import { usePalette } from '@/components/command-palette/palette-provider.tsx'
import { useAudioMemo } from '@/providers/audio-memo-provider.tsx'
import { useNoteFindActions } from '@/providers/note-find-provider.tsx'
import { useNoteTemplates } from '@/providers/note-templates-provider.tsx'
import { useShortcuts } from '@/providers/shortcuts-provider.tsx'
import { useSidebar } from '@/providers/sidebar-provider.tsx'
import { useFocusedNotePath } from '@/routing/use-focused-note-path.ts'
import { useRouterActions, useRouterHandlers, useRouterState } from '@/routing/router.tsx'
import {
  useAppServices,
  useCoreServices,
  useMaybeGraphServices,
} from '@/services/services-provider.tsx'
import { useCommandBlock, useCommands } from './use-commands.ts'
import { useCommandKeys } from './use-command-keys.ts'
import { useNoteCommands } from './use-note-commands.ts'

const NO_COMMANDS: readonly AppCommandId[] = []
const SHORTCUTS_SHOW: readonly AppCommandId[] = ['shortcuts.show']

/**
 * Register the main window's command handlers and run commands from the
 * keyboard. Mount once inside the router and the workspace providers.
 */
export function useWorkspaceCommands(): void {
  const services = useCoreServices()
  const app = useAppServices()
  const { route } = useRouterState()
  const { clearScrollState } = useRouterHandlers()
  const { navigate, selectSection, back, forward } = useRouterActions()
  const notePath = useFocusedNotePath()
  const { openPalette, open: paletteOpen } = usePalette()
  const { openShortcuts, closeShortcuts, open: shortcutsOpen } = useShortcuts()
  const { openTemplatePicker, openTemplateCreate, pickerOpen, createOpen } = useNoteTemplates()
  const { toggleSidebar } = useSidebar()
  const { toggle: toggleAudioMemo } = useAudioMemo()
  const noteFind = useNoteFindActions()
  // The workspace can outlive the open graph, and its chat session with it.
  const chat = useMaybeGraphServices()?.chat

  const switchGraph = (position: GraphSwitchPosition) => () => {
    return switchToRecentGraph(services.graphSession, app.graphBoot, position)
  }

  useCommands({
    'graph.switch1': switchGraph(1),
    'graph.switch2': switchGraph(2),
    'graph.switch3': switchGraph(3),
    'graph.switch4': switchGraph(4),
    'graph.switch5': switchGraph(5),
    'graph.switch6': switchGraph(6),
    'graph.switch7': switchGraph(7),
    'graph.switch8': switchGraph(8),
    'graph.switch9': switchGraph(9),
    // ⌘D is a capture gesture, not just navigation: the arrival asks the
    // stream to focus today's editor with the caret at the end of its
    // content, ready to append. Ordinary daily links and history moves stay
    // on the calm default (focus at the note start, or none).
    'nav.today': () => navigate({ kind: 'today' }, { focusEditor: true }),
    'nav.allNotes': () => selectSection('all'),
    'nav.tasks': () => selectSection('tasks'),
    'note.new': () => {
      // The fresh note is where attention moves, so a later return to the
      // daily stream re-anchors to its target instead of restoring the
      // pre-note position. Other routes keep their offsets.
      if (route.kind === 'today' || route.kind === 'daily') {
        clearScrollState()
      }
      navigate(newNoteRoute(services.noteCreation))
    },
    'note.random': async () => {
      const path = await services.indexQuery.randomNotePath()
      if (path !== null) {
        navigate({ kind: 'note', path })
      }
    },
    'note.find': () => {
      noteFind.openForPath(notePath)
    },
    'note.findNext': noteFind.next,
    'note.findPrevious': noteFind.previous,
    'chat.open': () => navigate({ kind: 'chat', conversationId: null }),
    'chat.new': route.kind === 'chat' ? () => chat?.newChat() : undefined,
    'history.back': back,
    'history.forward': forward,
    'palette.open': () => openPalette(),
    // The picker carries the empty state (a "New template" row), so the
    // command stays discoverable before any template exists.
    'template.insert': notePath === null ? undefined : openTemplatePicker,
    'template.new': openTemplateCreate,
    'audioMemo.toggle': toggleAudioMemo,
    'theme.toggle': () => app.theme.toggleTheme(),
    'sidebar.toggle': toggleSidebar,
    'settings.open': () => navigate({ kind: 'settings', page: 'main' }),
    'whatsNew.show': () => app.whatsNew.setOverride(true),
    'shortcuts.show': () => (shortcutsOpen ? closeShortcuts() : openShortcuts()),
    'semantic.enable': () => enableSemanticSearch(services),
    'index.rebuild': () => services.indexLifecycle.rebuildVisibly(),
    // The web inspector ships in every build (see `apps/tauri/src/devtools.rs`).
    // Plain-browser dev has no native shell, and its own DevTools.
    'dev.toggleDevtools': async () => {
      if (!services.platform.isNativeShell) {
        return
      }
      try {
        await app.window.toggleDevtools()
      } catch {
        // Best effort: a debug affordance never interrupts the user.
      }
    },
  })
  useNoteCommands(notePath)

  // The palette and the template dialogs are modal: nothing may run behind
  // them. The cheat-sheet is modal too, but ⌘/ closes it again.
  useCommandBlock(paletteOpen, NO_COMMANDS)
  useCommandBlock(shortcutsOpen, SHORTCUTS_SHOW)
  useCommandBlock(pickerOpen || createOpen, NO_COMMANDS)
  useCommandKeys()
}
