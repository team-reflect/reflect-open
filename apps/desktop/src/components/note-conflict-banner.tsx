import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert'
import { Button } from '@/components/ui/button'

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
    <InlineAlert className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1">This note changed on disk while you had unsaved edits.</span>
      <div className="flex gap-2">
        <Button size="xs" variant="outline" onClick={onKeepMine}>
          Keep mine
        </Button>
        <Button size="xs" variant="outline" onClick={onLoadTheirs}>
          Load theirs
        </Button>
      </div>
    </InlineAlert>
  )
}
