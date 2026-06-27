import { useCallback } from 'react'
import { dateFromDailyPath, type NoteRow, type PinnedNote } from '@reflect/core'
import { useQueryClient } from '@tanstack/react-query'
import {
  invalidatePinnedNotesCache,
  updatePinnedNotesCache,
} from '@/lib/notes/pinned-notes-cache'
import { useGraph } from '@/providers/graph-provider'

function titleFromPath(path: string): string {
  const name = path.split('/').at(-1) ?? path
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

function pinnedNoteFor(path: string, row: NoteRow | null): PinnedNote {
  return {
    path,
    title: row?.title ?? titleFromPath(path),
    dailyDate: row?.dailyDate ?? dateFromDailyPath(path),
    pinnedOrder: null,
  }
}

function comparePinnedNote(left: PinnedNote, right: PinnedNote): number {
  const titleOrder = left.title.localeCompare(right.title, undefined, { sensitivity: 'base' })
  return titleOrder === 0 ? left.path.localeCompare(right.path) : titleOrder
}

function insertPinnedNote(pinned: readonly PinnedNote[], note: PinnedNote): PinnedNote[] {
  const existing = pinned.filter((pinnedNote) => pinnedNote.path !== note.path)
  const ordered = existing.filter(
    (pinnedNote) => pinnedNote.pinnedOrder !== null && pinnedNote.pinnedOrder !== undefined,
  )
  const bare = [
    ...existing.filter(
      (pinnedNote) => pinnedNote.pinnedOrder === null || pinnedNote.pinnedOrder === undefined,
    ),
    note,
  ]
  bare.sort(comparePinnedNote)
  return [...ordered, ...bare]
}

export interface OptimisticPinToggle {
  /** Mirror a pin state into the pinned-notes cache before the index catches up. */
  readonly applyOptimisticPin: (active: boolean) => void
  /** Refetch pinned notes after a failed write. */
  readonly invalidateOptimisticPin: () => void
}

/**
 * Optimistically mirror the context-sidebar pin toggle into the pinned shelf.
 * The frontmatter write still owns truth; this only hides watcher/index latency.
 */
export function useOptimisticPinToggle(
  path: string,
  row: NoteRow | null,
): OptimisticPinToggle {
  const { graph } = useGraph()
  const queryClient = useQueryClient()

  const applyOptimisticPin = useCallback(
    (active: boolean): void => {
      if (graph === null) {
        return
      }
      const optimisticPinnedNote = pinnedNoteFor(path, row)
      updatePinnedNotesCache(queryClient, graph.root, (current) => {
        const pinned = current ?? []
        if (!active) {
          return pinned.filter((note) => note.path !== path)
        }
        return insertPinnedNote(pinned, optimisticPinnedNote)
      })
    },
    [graph, path, queryClient, row],
  )

  const invalidateOptimisticPin = useCallback((): void => {
    if (graph !== null) {
      invalidatePinnedNotesCache(queryClient, graph.root)
    }
  }, [graph, queryClient])

  return { applyOptimisticPin, invalidateOptimisticPin }
}
