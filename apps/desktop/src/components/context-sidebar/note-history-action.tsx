import type { ReactElement } from 'react'
import { History } from 'lucide-react'
import { useNoteHistory } from '@/providers/note-history-provider.tsx'
import { useCoreServices } from '@/services/services-provider.tsx'
import { NoteActionButton } from './note-action-button.tsx'

interface NoteHistoryActionProps {
  /** Graph-relative path of the note whose history to open. */
  path: string
}

/**
 * Opens the note history dialog. Rendered only in the native app, where every
 * graph keeps history in git; plain-browser dev has no git.
 */
export function NoteHistoryAction({ path }: NoteHistoryActionProps): ReactElement | null {
  const { platform } = useCoreServices()
  const { openNoteHistory } = useNoteHistory()
  if (!platform.isNativeShell) {
    return null
  }
  return (
    <NoteActionButton
      isActive={false}
      onClick={() => {
        openNoteHistory(path)
        return Promise.resolve()
      }}
      icon={<History size={14} aria-hidden />}
      labels={{ active: 'Note history', inactive: 'Note history' }}
    />
  )
}
