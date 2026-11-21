import type { AppCommandId } from '@reflect/app'
import { useCommandBlock, useCommands } from '@/commands/use-commands.ts'
import { useCommandKeys } from '@/commands/use-command-keys.ts'
import { useStore } from '@/lib/use-store.ts'
import { quickOpenVisible } from '@/mobile/quick-open.tsx'
import { openChat } from '@/mobile/sidebar.ts'
import { useRouterActions } from '@/routing/router.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'

const NO_COMMANDS: readonly AppCommandId[] = []

/**
 * Register the mobile handlers of the app commands and run them from a
 * hardware keyboard (iOS and Android). A command without a mobile handler
 * does nothing.
 */
export function useMobileShortcuts(): void {
  const { noteCreation } = useCoreServices()
  const { navigate, selectSection, back, forward } = useRouterActions()
  const quickOpen = useStore(quickOpenVisible)

  useCommands({
    'nav.today': () => navigate({ kind: 'today' }, { focusEditor: true }),
    'nav.allNotes': () => selectSection('all'),
    'nav.tasks': () => selectSection('tasks'),
    'note.new': () => navigate({ kind: 'note', path: noteCreation.untitledNotePath() }),
    'chat.open': () => openChat(navigate, selectSection),
    'palette.open': () => quickOpenVisible.set(true),
    'settings.open': () => navigate({ kind: 'settings', page: 'main' }),
    'history.back': back,
    'history.forward': forward,
  })
  // Quick open is modal: nothing may run behind it.
  useCommandBlock(quickOpen, NO_COMMANDS)
  useCommandKeys()
}
