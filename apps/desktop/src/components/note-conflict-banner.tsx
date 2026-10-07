import type { ReactElement } from 'react'
import { InlineAlert } from '@/components/inline-alert.tsx'
import { Button } from '@/components/ui/button.tsx'

interface NoteConflictBannerProps {
  /** Resolve by keeping the editor buffer (rewrites the file). */
  onKeepMine: () => void
  /** Resolve by loading the external content (discards the buffer). */
  onLoadTheirs: () => void
  /**
   * Set when a three-way merge exists for the overlap: resolve by keeping
   * both sides of every overlapping block, or by opening the marked merge
   * for block-by-block review.
   */
  onKeepBoth?: (() => void) | undefined
  onReview?: (() => void) | undefined
}

/**
 * The non-destructive conflict prompt (Plan 05): an external change raced
 * unsaved edits, saves are paused, and nothing is written until the user
 * picks a side. Edits that do not overlap merge silently before this is ever
 * shown; the banner appears only for overlapping edits (with Keep both and
 * Review) or when no merge was possible (two choices).
 */
export function NoteConflictBanner({
  onKeepMine,
  onLoadTheirs,
  onKeepBoth,
  onReview,
}: NoteConflictBannerProps): ReactElement {
  const mergeable = onKeepBoth !== undefined && onReview !== undefined
  return (
    <InlineAlert className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="min-w-0 flex-1">
        {mergeable
          ? 'This note changed on disk, and the changes overlap your unsaved edits.'
          : 'This note changed on disk while you had unsaved edits.'}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button size="xs" variant="outline" onClick={onKeepMine}>
          Keep mine
        </Button>
        <Button size="xs" variant="outline" onClick={onLoadTheirs}>
          Load theirs
        </Button>
        {mergeable ? (
          <>
            <Button size="xs" variant="outline" onClick={onKeepBoth}>
              Keep both
            </Button>
            <Button size="xs" variant="outline" onClick={onReview}>
              Review
            </Button>
          </>
        ) : null}
      </div>
    </InlineAlert>
  )
}
