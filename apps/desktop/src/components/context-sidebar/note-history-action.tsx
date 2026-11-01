import type { ReactElement } from 'react'
import { History } from 'lucide-react'
import { useNoteHistoryAvailable } from '@/hooks/use-note-history.ts'
import { useNoteHistory } from '@/providers/note-history-provider.tsx'
import { NoteActionButton } from './note-action-button.tsx'

interface NoteHistoryActionProps {
  /** Graph-relative path of the note whose history to open. */
  path: string
}

/**
 * Opens the note history dialog. Rendered only when the graph keeps history
 * (it has a git repository).
 */
export function NoteHistoryAction({ path }: NoteHistoryActionProps): ReactElement | null {
  const available = useNoteHistoryAvailable()
  const { openNoteHistory } = useNoteHistory()
  if (!available) {
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
