import type { AppCommandId } from '@reflect/app'
import { useCommandBlock, useCommandHandler } from '@/commands/use-commands.ts'
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

  useCommandHandler('nav.today', () => navigate({ kind: 'today' }, { focusEditor: true }))
  useCommandHandler('nav.allNotes', () => selectSection('all'))
  useCommandHandler('nav.tasks', () => selectSection('tasks'))
  useCommandHandler('note.new', () => {
    navigate({ kind: 'note', path: noteCreation.untitledNotePath() })
  })
  useCommandHandler('chat.open', () => openChat(navigate, selectSection))
  useCommandHandler('palette.open', () => quickOpenVisible.set(true))
  useCommandHandler('settings.open', () => navigate({ kind: 'settings', page: 'main' }))
  useCommandHandler('history.back', back)
  useCommandHandler('history.forward', forward)
  // Quick open is modal: nothing may run behind it.
  useCommandBlock(quickOpen, NO_COMMANDS)
  useCommandKeys()
}
