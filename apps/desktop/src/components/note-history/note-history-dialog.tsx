import type { ReactElement } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog.tsx'
import { useNoteHistory } from '@/providers/note-history-provider.tsx'
import { NoteHistoryBody } from './note-history-body.tsx'

/**
 * The note history dialog: the note's past versions from the graph's git
 * history on the left, the selected one previewed on the right, and a
 * restore that replaces the note's text with it. Opened from Note actions or
 * the "Show note history" command.
 */
export function NoteHistoryDialog(): ReactElement | null {
  const { historyPath, closeNoteHistory } = useNoteHistory()
  if (historyPath === null) {
    return null
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeNoteHistory()
        }
      }}
    >
      <DialogContent className="flex h-[min(80dvh,40rem)] flex-col gap-0 p-0 sm:max-w-4xl">
        <NoteHistoryBody path={historyPath} onRestored={closeNoteHistory} />
      </DialogContent>
    </Dialog>
  )
}
