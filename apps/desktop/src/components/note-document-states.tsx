import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert'
import { NoteConflictBanner } from '@/components/note-conflict-banner'
import type { NoteDocument } from '@/editor/use-note-document'
import { cn } from '@/lib/utils'

/** Placeholder while a note document loads. */
export function NoteLoading({ className }: { className?: string }): ReactElement {
  // `reflect-note-loading` keeps the hint invisible for the first beat:
  // local reads resolve in milliseconds, and the text flashing on every
  // daily-stream row reads as flicker while the stream anchors.
  return (
    <div className={cn('reflect-note-loading px-1 py-2 text-sm text-text-muted', className)}>
      Loading note…
    </div>
  )
}

interface NoteOpenErrorProps {
  path: string
  message: string | null
  className?: string
}

/** A note document that failed its initial load. */
export function NoteOpenError({ path, message, className }: NoteOpenErrorProps): ReactElement {
  return (
    <div role="alert" className={cn('px-1 py-2 text-sm text-red-500', className)}>
      Couldn’t open {path}: {message}
    </div>
  )
}

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
