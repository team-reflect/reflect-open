import type { AppCommandId } from '@reflect/app'
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
import { useCommandBlock, useCommandHandler } from './use-commands.ts'
import { useCommandKeys } from './use-command-keys.ts'
import { useNoteCommands } from './use-note-commands.ts'
import { usePinnedNoteCommands } from './use-pinned-note-commands.ts'

const NO_COMMANDS: readonly AppCommandId[] = []
const SHORTCUTS_SHOW: readonly AppCommandId[] = ['shortcuts.show']

/**
 * Register the main window's command handlers and run commands from the
 * keyboard. Mount once inside the router and the workspace providers.
 */
export function useWorkspaceCommands(): void {
  const {
    graphSession,
    noteCreation,
    indexQuery,
    settings,
    semanticSearch,
    indexLifecycle,
    platform,
  } = useCoreServices()
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

  // `index` is zero-based: `graph.switch1` opens `recents[0]`.
  const switchGraph = (index: number) => async () => {
    const { recents, graph } = graphSession.get()
    const recent = recents[index]
    if (recent !== undefined && recent.root !== graph?.root) {
      await app.graphBoot.openRecent(recent.root)
    }
  }

  useCommandHandler('graph.switch1', switchGraph(0))
  useCommandHandler('graph.switch2', switchGraph(1))
  useCommandHandler('graph.switch3', switchGraph(2))
  useCommandHandler('graph.switch4', switchGraph(3))
  useCommandHandler('graph.switch5', switchGraph(4))
  useCommandHandler('graph.switch6', switchGraph(5))
  useCommandHandler('graph.switch7', switchGraph(6))
  useCommandHandler('graph.switch8', switchGraph(7))
  useCommandHandler('graph.switch9', switchGraph(8))
  // ⌘D is a capture gesture, not just navigation: the arrival asks the
  // stream to focus today's editor with the caret at the end of its
  // content, ready to append. Ordinary daily links and history moves stay
  // on the calm default (focus at the note start, or none).
  useCommandHandler('nav.today', () => navigate({ kind: 'today' }, { focusEditor: true }))
  useCommandHandler('nav.allNotes', () => selectSection('all'))
  useCommandHandler('nav.tasks', () => selectSection('tasks'))
  useCommandHandler('note.new', () => {
    // The fresh note is where attention moves, so a later return to the
    // daily stream re-anchors to its target instead of restoring the
    // pre-note position. Other routes keep their offsets.
    if (route.kind === 'today' || route.kind === 'daily') {
      clearScrollState()
    }
    navigate({ kind: 'note', path: noteCreation.untitledNotePath() })
  })
  useCommandHandler('note.random', async () => {
    const path = await indexQuery.randomNotePath()
    if (path !== null) {
      navigate({ kind: 'note', path })
    }
  })
  useCommandHandler(
    'note.find',
    notePath === null
      ? undefined
      : () => {
          noteFind.openForPath(notePath)
        },
  )
  useCommandHandler('note.findNext', noteFind.next)
  useCommandHandler('note.findPrevious', noteFind.previous)
  useCommandHandler('chat.open', () => navigate({ kind: 'chat', conversationId: null }))
  useCommandHandler('chat.new', route.kind === 'chat' ? () => chat?.newChat() : undefined)
  useCommandHandler('history.back', back)
  useCommandHandler('history.forward', forward)
  useCommandHandler('palette.open', () => openPalette())
  // The picker carries the empty state (a "New template" row), so the
  // command stays discoverable before any template exists.
  useCommandHandler('template.insert', notePath === null ? undefined : openTemplatePicker)
  useCommandHandler('template.new', openTemplateCreate)
  useCommandHandler('audioMemo.toggle', toggleAudioMemo)
  useCommandHandler('theme.toggle', () => app.theme.toggleTheme())
  useCommandHandler('sidebar.toggle', toggleSidebar)
  useCommandHandler('settings.open', () => navigate({ kind: 'settings', page: 'main' }))
  useCommandHandler('whatsNew.show', () => app.whatsNew.setOverride(true))
  useCommandHandler('shortcuts.show', () => (shortcutsOpen ? closeShortcuts() : openShortcuts()))
  // Downloading the local model (~90MB) is the user's call, never automatic:
  // EmbeddingsSync loads it when the flag flips on. A `failed` runtime
  // retries only on an explicit action like this one.
  useCommandHandler('semantic.enable', async () => {
    settings.update({ semanticSearchEnabled: true })
    await semanticSearch.retryFailedModel()
  })
  useCommandHandler('index.rebuild', () => indexLifecycle.rebuildVisibly())
  // The web inspector ships in every build (see `apps/tauri/src/devtools.rs`).
  // Plain-browser dev has no native shell, and its own DevTools.
  useCommandHandler('dev.toggleDevtools', async () => {
    if (!platform.isNativeShell) {
      return
    }
    try {
      await app.window.toggleDevtools()
    } catch {
      // Best effort: a debug affordance never interrupts the user.
    }
  })
  useNoteCommands(notePath)
  usePinnedNoteCommands()

  // The palette and the template dialogs are modal: nothing may run behind
  // them. The cheat-sheet is modal too, but ⌘/ closes it again.
  useCommandBlock(paletteOpen, NO_COMMANDS)
  useCommandBlock(shortcutsOpen, SHORTCUTS_SHOW)
  useCommandBlock(pickerOpen || createOpen, NO_COMMANDS)
  useCommandKeys()
}
