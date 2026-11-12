import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import type { AssetSaveError } from '@reflect/core'

interface NoteSaveAlertsProps {
  /** The session's save error, if its last write failed. */
  saveError: string | null
  /** A pasted image or dropped file that could not be saved. */
  assetSaveError?: AssetSaveError | null | undefined
}

/** What went wrong saving a ready document. */
export function NoteSaveAlerts({
  saveError,
  assetSaveError = null,
}: NoteSaveAlertsProps): ReactElement {
  return (
    <>
      {saveError !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Saving failed: {saveError}. Your edits are kept in the editor and the next successful save
          will persist them.
        </InlineAlert>
      ) : null}
      {assetSaveError !== null ? (
        <InlineAlert tone="error" className="mb-4">
          Couldn’t save the {assetSaveError.kind === 'image' ? 'pasted image' : 'file'}:{' '}
          {assetSaveError.message}. It was not added to the note.
        </InlineAlert>
      ) : null}
    </>
  )
}
