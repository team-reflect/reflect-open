import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { arrayMove } from '@dnd-kit/sortable'
import type { PinnedNote } from '@reflect/core'
import { reorderPinnedNotes } from '@/lib/note-pin'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { updatePinOrder } from '@/lib/notes/pin-order'
import { invalidatePinnedNotesCache, updatePinnedNotesCache } from '@/lib/notes/pinned-notes-cache'

interface ReorderPinnedNotesVariables {
  generation: number
  root: string
  notes: readonly PinnedNote[]
}

export function useReorderPinnedNotes(
  pinned: readonly PinnedNote[],
): (activePath: string, overPath: string) => void {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const { mutate } = useMutation({
    mutationKey: mutationKeys.pinnedNotes.reorder(graph?.root),
    scope: { id: mutationScopeIds.pinnedNotesReorder(graph?.root) },
    mutationFn: (variables: ReorderPinnedNotesVariables) =>
      reorderPinnedNotes(variables.notes, variables.generation),
    onError: (_error, variables) => {
      if (
        queryClient.isMutating({
          exact: true,
          mutationKey: mutationKeys.pinnedNotes.reorder(variables.root),
        }) === 1
      ) {
        invalidatePinnedNotesCache(queryClient, variables.root)
      }
    },
  })

  return useCallback(
    (activePath: string, overPath: string): void => {
      if (graph === null) {
        return
      }

      const activeIndex = pinned.findIndex((note) => note.path === activePath)
      const overIndex = pinned.findIndex((note) => note.path === overPath)
      if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
        return
      }

      // Move the note in the array.
      const moved: PinnedNote[] = arrayMove([...pinned], activeIndex, overIndex)

      // Update `note.pinnedOrder` in the moved note.
      const renumbered: PinnedNote[] | null = updatePinOrder(moved, activePath)

      const next: PinnedNote[] = renumbered ?? moved

      void queryClient.cancelQueries({ queryKey: queryKeys.index.pinnedNotes(graph.root) })
      updatePinnedNotesCache(queryClient, graph.root, () => next)
      mutate({ generation: graph.generation, root: graph.root, notes: renumbered })
    },
    [graph, mutate, pinned, queryClient],
  )
}
