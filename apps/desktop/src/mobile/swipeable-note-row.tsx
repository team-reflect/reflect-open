import type { ReactElement, ReactNode } from 'react'
import { Pin, PinOff, Trash2 } from 'lucide-react'
import { type HighlightSegment, formatRecencyLabel } from '@reflect/core'
import { SWIPE_ACTION_WIDTH, SwipeActionButton } from '@/mobile/swipe-action-button.tsx'
import { type RevealedRowStore, useRevealedRow } from '@/mobile/revealed-row.ts'
import { SwipeRow } from '@/mobile/swipe-row.tsx'
import { useSettings } from '@/providers/settings-provider.tsx'

/** V1's fixed row height (px) — placeholder resolution never causes jumps. */
export const NOTE_ROW_HEIGHT = 64

/** One rendered row with query-aware title and snippet segments. */
export interface NoteRowModel {
  path: string
  /** Title split into plain and highlighted free-text search matches. */
  titleSegments: HighlightSegment[]
  /** File modification time (epoch ms) — the relative timestamp. */
  mtime: number
  isPinned: boolean
  /** Daily notes are part of the chronological spine and cannot be deleted. */
  canDelete: boolean
  /** First content line; search hits carry highlighted match segments. */
  snippet: HighlightSegment[]
}

interface SwipeableNoteRowProps {
  row: NoteRowModel
  /**
   * The list's one revealed row, keyed by note path.
   */
  revealedRow: RevealedRowStore
  onOpen: () => void
  onTogglePin: () => void
  onDelete: () => void
}

function renderHighlightedSegments(segments: HighlightSegment[]): ReactNode {
  return segments.map((segment, index) => {
    return segment.highlighted ? (
      <mark key={index} className="rounded-sm bg-primary/15 text-text">
        {segment.text}
      </mark>
    ) : (
      <span key={index}>{segment.text}</span>
    )
  })
}

/**
 * One note row over its iOS-style reveal actions, on a native-scroll
 * {@link SwipeRow}. This component owns the note-specific content and
 * accessible action controls.
 */
export function SwipeableNoteRow({
  row,
  revealedRow,
  onOpen,
  onTogglePin,
  onDelete,
}: SwipeableNoteRowProps): ReactElement {
  const { settings } = useSettings()
  const { revealed, reveal, close, beginInteraction } = useRevealedRow(revealedRow, row.path)
  const actionWidth = SWIPE_ACTION_WIDTH * (row.canDelete ? 2 : 1)
  const title = row.titleSegments.map((segment) => segment.text).join('')
  const activate = (): void => {
    if (revealed) {
      close()
      return
    }
    onOpen()
  }

  return (
    <div className="border-b border-border" style={{ height: NOTE_ROW_HEIGHT }}>
      <SwipeRow
        actionWidth={actionWidth}
        revealed={revealed}
        onReveal={reveal}
        onClose={close}
        onBeginInteraction={beginInteraction}
        className="h-full"
        surfaceClassName="bg-background"
        actions={
          <>
            <SwipeActionButton
              icon={row.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              label={row.isPinned ? 'Unpin' : 'Pin'}
              ariaLabel={`${row.isPinned ? 'Unpin' : 'Pin'} ${title}`}
              revealed={revealed}
              className="bg-accent"
              onClick={() => {
                close()
                onTogglePin()
              }}
            />
            {row.canDelete ? (
              <SwipeActionButton
                icon={<Trash2 className="size-4" />}
                label="Delete"
                ariaLabel={`Delete ${title}`}
                revealed={revealed}
                className="bg-destructive"
                onClick={onDelete}
              />
            ) : null}
          </>
        }
      >
        <button
          type="button"
          onClick={activate}
          className="flex h-full w-full flex-col justify-center gap-0.5 overflow-hidden px-4 text-left"
        >
          <span className="flex w-full items-baseline gap-2">
            {row.isPinned ? (
              <>
                <Pin aria-hidden className="size-3 shrink-0 self-center text-text-muted" />
                <span className="sr-only">Pinned</span>
              </>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm font-medium">
              {renderHighlightedSegments(row.titleSegments)}
            </span>
            <span className="shrink-0 text-xs text-text-muted">
              {formatRecencyLabel(row.mtime, settings)}
            </span>
          </span>
          {row.snippet.length > 0 ? (
            <span className="w-full truncate text-xs text-text-muted">
              {renderHighlightedSegments(row.snippet)}
            </span>
          ) : null}
        </button>
      </SwipeRow>
    </div>
  )
}
