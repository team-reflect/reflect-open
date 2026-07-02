import { type ReactElement } from 'react'
import { Pin } from 'lucide-react'
import { Virtualizer } from 'virtua'
import type { HighlightSegment } from '@reflect/core'
import { formatRecencyLabel } from '@/lib/dates'
import { useSettings } from '@/providers/settings-provider'

/** V1's fixed row height (px) — placeholder resolution never causes jumps. */
export const NOTE_ROW_HEIGHT = 64

/** One rendered row: a note with its snippet resolved to segments. */
export interface NoteRowModel {
  path: string
  title: string
  /** File modification time (epoch ms) — the relative timestamp. */
  mtime: number
  isPinned: boolean
  /** First content line; search hits carry highlighted match segments. */
  snippet: HighlightSegment[]
}

interface NoteRowListProps {
  rows: NoteRowModel[]
  onOpen: (path: string) => void
}

/**
 * The All tab's virtualized note list: fixed-height rows (title, first
 * content line, relative timestamp, a pin marker on pinned notes) shared by
 * the plain list, the filtered feed, and search results — V1's one row shape.
 */
export function NoteRowList({ rows, onOpen }: NoteRowListProps): ReactElement {
  const { settings } = useSettings()

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      // Keyboard avoidance is the shell root's job (it ends at the keyboard's
      // top); this only clears the home indicator when the keyboard is down.
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <Virtualizer as="ul" item="li" data={rows} itemSize={NOTE_ROW_HEIGHT} bufferSize={640}>
        {(row) => (
          <button
            key={row.path}
            type="button"
            onClick={() => onOpen(row.path)}
            className="flex w-full flex-col justify-center gap-0.5 overflow-hidden border-b border-border px-4 text-left"
            style={{ height: NOTE_ROW_HEIGHT }}
          >
            <span className="flex w-full items-baseline gap-2">
              {row.isPinned && (
                <>
                  <Pin aria-hidden className="size-3 shrink-0 self-center text-text-muted" />
                  <span className="sr-only">Pinned</span>
                </>
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span>
              <span className="shrink-0 text-xs text-text-muted">
                {formatRecencyLabel(row.mtime, settings)}
              </span>
            </span>
            {row.snippet.length > 0 && (
              <span className="w-full truncate text-xs text-text-muted">
                {row.snippet.map((segment, index) =>
                  segment.highlighted ? (
                    <mark key={index} className="rounded-sm bg-primary/15 text-text">
                      {segment.text}
                    </mark>
                  ) : (
                    <span key={index}>{segment.text}</span>
                  ),
                )}
              </span>
            )}
          </button>
        )}
      </Virtualizer>
    </div>
  )
}
