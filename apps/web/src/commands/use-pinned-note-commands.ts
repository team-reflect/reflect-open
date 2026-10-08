import { useRouterActions } from '@/routing/router.tsx'
import { useAppServices, useCoreServices } from '@/services/services-provider.tsx'
import { openPinnedNote } from './open-pinned-note.ts'
import { useCommandHandler } from './use-commands.ts'

/**
 * Register the ⌘6–⌘9 open-pinned-note handlers.
 */
export function usePinnedNoteCommands(): void {
  const services = useCoreServices()
  const app = useAppServices()
  const { navigate } = useRouterActions()
  const open = (index: number) => () => openPinnedNote({ services, app, navigate }, index)

  useCommandHandler('pinned.open1', open(0))
  useCommandHandler('pinned.open2', open(1))
  useCommandHandler('pinned.open3', open(2))
  useCommandHandler('pinned.open4', open(3))
}
