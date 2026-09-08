import { useCallback } from 'react'
import type { NoteRow } from '@reflect/core'
import { useQueryClient } from '@tanstack/react-query'
import { insertPinnedNote, invalidatePinnedNotesCache, pinnedNoteFor, updatePinnedNotesCache } from '@/lib/notes/pinned-notes-cache'
import { useGraph } from '@/providers/graph-provider'

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
export function useOptimisticPinToggle(path: string, row: NoteRow | null): OptimisticPinToggle {
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
