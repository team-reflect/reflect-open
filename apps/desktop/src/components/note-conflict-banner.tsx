import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert'

interface NoteConflictBannerProps {
  /** Resolve by keeping the editor buffer (rewrites the file). */
  onKeepMine: () => void
  /** Resolve by loading the external content (discards the buffer). */
  onLoadTheirs: () => void
}

/**
 * The non-destructive conflict prompt (Plan 05): an external change raced
 * unsaved edits, saves are paused, and nothing is written until the user
 * picks a side. The two actions map 1:1 onto the note session's
 * `keepMine`/`loadTheirs`.
 */
export function NoteConflictBanner({
  onKeepMine,
  onLoadTheirs,
}: NoteConflictBannerProps): ReactElement {
  return (
    <InlineAlert className="mb-4 flex flex-wrap items-center gap-3">
      <span className="min-w-0 flex-1">
        This note changed on disk while you had unsaved edits.
      </span>
      <button
        type="button"
        onClick={onKeepMine}
        className="rounded border border-current/30 px-2 py-0.5 font-medium"
      >
        Keep mine
      </button>
      <button
        type="button"
        onClick={onLoadTheirs}
        className="rounded border border-current/30 px-2 py-0.5 font-medium"
      >
        Load theirs
      </button>
    </InlineAlert>
  )
}
