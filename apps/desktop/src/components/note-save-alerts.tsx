import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert'
import { NoteConflictBanner } from '@/components/note-conflict-banner'
import type { AssetSaveError } from '@/editor/use-asset-persistence'
import type { NoteDocument } from '@/editor/use-note-document'

interface NoteSaveAlertsProps {
  document: NoteDocument
  /** A pasted image or dropped file that could not be saved. */
  assetSaveError?: AssetSaveError | null
}

/** What went wrong saving a ready document, and the external-change conflict prompt. */
export function NoteSaveAlerts({
  document,
  assetSaveError = null,
}: NoteSaveAlertsProps): ReactElement {
  return (
    <>
      {document.error !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Saving failed: {document.error}. Your edits are kept in the editor and the next successful
          save will persist them.
        </InlineAlert>
      ) : null}
      {assetSaveError !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Couldn’t save the {assetSaveError.kind === 'image' ? 'pasted image' : 'file'}:{' '}
          {assetSaveError.message}. It was not added to the note.
        </InlineAlert>
      ) : null}
      {document.conflict !== null ? (
        <NoteConflictBanner onKeepMine={document.keepMine} onLoadTheirs={document.loadTheirs} />
      ) : null}
    </>
  )
}
