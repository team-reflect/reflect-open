import { useNoteFindActions } from '@/providers/note-find-provider.tsx'
import { useRouterActions } from '@/routing/router.tsx'
import { useFocusedNotePath } from '@/routing/use-focused-note-path.ts'
import { useCommands } from './use-commands.ts'
import { useCommandKeys } from './use-command-keys.ts'
import { useNoteCommands } from './use-note-commands.ts'

/**
 * Register a secondary note window's command handlers and run commands from
 * the keyboard. History moves this window's own router. A command with no
 * handler here (New note, Settings, ...) runs in the main window when it comes
 * from the native menu.
 */
export function useNoteWindowCommands(): void {
  const { back, forward } = useRouterActions()
  const notePath = useFocusedNotePath()
  const noteFind = useNoteFindActions()

  useCommands({
    'history.back': back,
    'history.forward': forward,
    'note.find': () => {
      noteFind.openForPath(notePath)
    },
    'note.findNext': noteFind.next,
    'note.findPrevious': noteFind.previous,
  })
  useNoteCommands(notePath)
  useCommandKeys()
}
