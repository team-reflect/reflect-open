import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert'
import { NoteConflictBanner } from '@/components/note-conflict-banner'
import type { NoteDocument } from '@/editor/use-note-document'

/** The save-failure alert and the external-change conflict prompt of a ready document. */
export function NoteSaveAlerts({ document }: { document: NoteDocument }): ReactElement {
  return (
    <>
      {document.error !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Saving failed: {document.error}. Your edits are kept in the editor and the next successful
          save will persist them.
        </InlineAlert>
      ) : null}
      {document.conflict !== null ? (
        <NoteConflictBanner onKeepMine={document.keepMine} onLoadTheirs={document.loadTheirs} />
      ) : null}
    </>
  )
}
