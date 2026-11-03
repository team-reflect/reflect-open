import { useEffect, useRef, type KeyboardEvent, type ReactElement } from 'react'
import type { NoteRevision } from '@reflect/core'
import { formatDate } from '@reflect/utils'
import { Button } from '@/components/ui/button.tsx'
import { Spinner } from '@/components/ui/spinner.tsx'
import type { NoteRevisions } from '@/hooks/use-note-history.ts'
import { cn } from '@/lib/utils.ts'

interface NoteRevisionListProps {
  history: NoteRevisions
  selectedOid: string | null
  onSelect: (revision: NoteRevision) => void
}

/** A revision's id within the list, for `aria-activedescendant`. */
function optionId(oid: string): string {
  return `note-revision-${oid}`
}

/**
 * The history dialog's scrolled list of revisions, newest first: a listbox
 * the arrow keys move through, loading older pages as its end scrolls into
 * view. A failed load stops that and offers a retry.
 */
export function NoteRevisionList({
  history,
  selectedOid,
  onSelect,
}: NoteRevisionListProps): ReactElement {
  const { revisions, hasNextPage, isFetchingNextPage, loadMoreFailed, loadMore } = history
  const listRef = useRef<HTMLDivElement>(null)
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const end = endRef.current
    if (end === null || !hasNextPage || loadMoreFailed) {
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMore()
      }
    })
    observer.observe(end)
    return () => observer.disconnect()
  }, [hasNextPage, loadMoreFailed, loadMore])

  useEffect(() => {
    if (selectedOid !== null) {
      document.getElementById(optionId(selectedOid))?.scrollIntoView({ block: 'nearest' })
    }
  }, [selectedOid])

  useEffect(() => {
    listRef.current?.focus()
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) {
      return
    }
    event.preventDefault()
    const index = revisions.findIndex((revision) => revision.oid === selectedOid)
    const nextIndex = Math.min(Math.max(index + step, 0), revisions.length - 1)
    const next = revisions[nextIndex]
    if (next !== undefined) {
      onSelect(next)
    }
    if (nextIndex === revisions.length - 1) {
      loadMore()
    }
  }

  return (
    <div className="min-h-0 overflow-y-auto p-2">
      <div
        ref={listRef}
        role="listbox"
        aria-label="Versions"
        tabIndex={0}
        aria-activedescendant={selectedOid === null ? undefined : optionId(selectedOid)}
        onKeyDown={onKeyDown}
        className="flex flex-col gap-0.5 outline-none"
      >
        {revisions.map((revision) => {
          const selected = revision.oid === selectedOid
          return (
            <div
              key={revision.oid}
              id={optionId(revision.oid)}
              role="option"
              aria-selected={selected}
              onClick={() => onSelect(revision)}
              className={cn(
                'cursor-default rounded-lg px-3 py-2 text-text-muted hover:bg-surface-hover',
                selected && 'bg-surface-hover text-text',
              )}
            >
              <div className="truncate text-xs font-medium">
                {formatDate(new Date(revision.timeMs), 'PP p')}
              </div>
              <div className="truncate text-xs">{revision.summary}</div>
            </div>
          )
        })}
      </div>
      <div ref={endRef} className="flex justify-center py-2">
        {isFetchingNextPage ? (
          <Spinner className="size-4 text-text-muted" />
        ) : loadMoreFailed ? (
          <Button size="xs" variant="ghost" onClick={loadMore}>
            Couldn’t load older versions. Try again
          </Button>
        ) : null}
      </div>
    </div>
  )
}
