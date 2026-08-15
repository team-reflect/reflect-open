import type { ReactElement, ReactNode } from 'react'
import { Pin, PinOff, Trash2 } from 'lucide-react'
import type { HighlightSegment } from '@reflect/core'
import { formatRecencyLabel } from '@/lib/dates'
import { useNoteRowSwipe } from '@/mobile/use-note-row-swipe'
import { useSettings } from '@/providers/settings-provider'

/** V1's fixed row height (px) — placeholder resolution never causes jumps. */
export const NOTE_ROW_HEIGHT = 64

const ACTION_BUTTON_WIDTH = 68

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
  revealed: boolean
  onReveal: () => void
  onClose: () => void
  onBeginInteraction: () => void
  onOpen: () => void
  onTogglePin: () => void
  onDelete: () => void
}

function renderHighlightedSegments(segments: HighlightSegment[]): ReactNode {
  return segments.map((segment, index) =>
    segment.highlighted ? (
      <mark key={index} className="rounded-sm bg-primary/15 text-text">
        {segment.text}
      </mark>
    ) : (
      <span key={index}>{segment.text}</span>
    ),
  )
}

/**
 * One note row over its iOS-style reveal actions. The gesture physics live in
 * {@link useNoteRowSwipe}; this component owns the note-specific content and
 * accessible action controls.
 */
export function SwipeableNoteRow({
  row,
  revealed,
  onReveal,
  onClose,
  onBeginInteraction,
  onOpen,
  onTogglePin,
  onDelete,
}: SwipeableNoteRowProps): ReactElement {
  const { settings } = useSettings()
  const actionWidth = ACTION_BUTTON_WIDTH * (row.canDelete ? 2 : 1)
  const title = row.titleSegments.map((segment) => segment.text).join('')
  const swipe = useNoteRowSwipe({
    actionWidth,
    revealed,
    onReveal,
    onClose,
    onBeginInteraction,
  })

  return (
    <div
      className="relative overflow-hidden border-b border-border"
      style={{ height: NOTE_ROW_HEIGHT }}
    >
      <div
        className="absolute inset-y-0 right-0 flex"
        style={{ width: actionWidth }}
        aria-hidden={!revealed || undefined}
        inert={!revealed}
      >
        <button
          type="button"
          tabIndex={revealed ? 0 : -1}
          className="flex h-full flex-col items-center justify-center gap-1 bg-accent text-[10px] font-medium text-text-on-brand active:opacity-70"
          style={{ width: ACTION_BUTTON_WIDTH }}
          aria-label={`${row.isPinned ? 'Unpin' : 'Pin'} ${title}`}
          onClick={() => {
            onClose()
            onTogglePin()
          }}
        >
          {row.isPinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          <span aria-hidden>{row.isPinned ? 'Unpin' : 'Pin'}</span>
        </button>
        {row.canDelete ? (
          <button
            type="button"
            tabIndex={revealed ? 0 : -1}
            className="flex h-full flex-col items-center justify-center gap-1 bg-destructive text-[10px] font-medium text-text-on-brand active:opacity-70"
            style={{ width: ACTION_BUTTON_WIDTH }}
            aria-label={`Delete ${title}`}
            onClick={onDelete}
          >
            <Trash2 className="size-4" />
            <span aria-hidden>Delete</span>
          </button>
        ) : null}
      </div>
      <button
        type="button"
        {...swipe.handlers}
        onClick={(event) => {
          if (swipe.consumeDragClick()) {
            event.preventDefault()
            return
          }
          if (revealed) {
            onClose()
            return
          }
          onOpen()
        }}
        className="absolute inset-0 flex w-full flex-col justify-center gap-0.5 overflow-hidden bg-background px-4 text-left active:opacity-70"
        style={{ ...swipe.style, height: NOTE_ROW_HEIGHT }}
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
    </div>
  )
}
