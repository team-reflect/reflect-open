import { useState, type ReactElement } from 'react'
import { errorMessage } from '@reflect/core'
import { formatDate } from '@reflect/utils'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import { useAsyncAction } from '@/hooks/use-async-action.ts'
import { useNoteRevisions } from '@/hooks/use-note-history.ts'
import { useCoreServices } from '@/services/services-provider.tsx'
import { NoteRevisionList } from './note-revision-list.tsx'
import { NoteRevisionPreview } from './note-revision-preview.tsx'

interface NoteHistoryBodyProps {
  path: string
  onRestored: () => void
}

/**
 * The dialog's contents: the revision list, the selected revision's preview
 * and its restore button.
 */
export function NoteHistoryBody({ path, onRestored }: NoteHistoryBodyProps): ReactElement {
  const { noteHistory } = useCoreServices()
  const history = useNoteRevisions(path)
  const [selectedOid, setSelectedOid] = useState<string | null>(null)
  const restore = useAsyncAction()
  const selected =
    history.revisions.find((revision) => revision.oid === selectedOid) ??
    history.revisions[0] ??
    null

  const restoreSelected = (): void => {
    if (selected === null) {
      return
    }
    void restore.run(async () => {
      await noteHistory.restore(path, selected)
      onRestored()
    })
  }

  return (
    <>
      <DialogHeader className="border-b border-border px-4 py-3">
        <DialogTitle>Note history</DialogTitle>
        <DialogDescription>
          Every version of this note saved to your graph’s history.
        </DialogDescription>
      </DialogHeader>
      {history.error !== null ? (
        <InlineAlert tone="error" className="m-4">
          {errorMessage(history.error)}
        </InlineAlert>
      ) : history.isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner className="size-4 text-text-muted" />
        </div>
      ) : selected === null ? (
        <p className="flex flex-1 items-center justify-center text-xs text-text-muted">
          No saved versions yet. Edits are saved to history every few seconds.
        </p>
      ) : (
        <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,10rem)_1fr] sm:grid-cols-[16rem_1fr] sm:grid-rows-none">
          <div className="flex min-h-0 flex-col border-b border-border sm:border-r sm:border-b-0">
            <NoteRevisionList
              history={history}
              selectedOid={selected.oid}
              onSelect={(revision) => setSelectedOid(revision.oid)}
            />
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                {formatDate(new Date(selected.timeMs), 'PPPP p')}
              </span>
              <Button size="sm" onClick={restoreSelected} disabled={restore.pending}>
                {restore.pending ? 'Restoring…' : 'Restore this version'}
              </Button>
            </div>
            {restore.error !== null ? (
              <InlineAlert tone="error" className="mx-4 mt-3">
                {restore.error}
              </InlineAlert>
            ) : null}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
              <NoteRevisionPreview revision={selected} />
            </div>
          </div>
        </div>
      )}
    </>
  )
}
