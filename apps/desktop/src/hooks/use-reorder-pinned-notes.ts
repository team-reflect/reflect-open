import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { arrayMove } from '@dnd-kit/sortable'
import type { PinnedNote } from '@reflect/core'
import { reorderPinnedNotes } from '@/lib/note-pin'
import { mutationKeys, mutationScopeIds } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { invalidatePinnedNotesCache, updatePinnedNotesCache } from '@/lib/notes/pinned-notes-cache'

interface ReorderPinnedNotesVariables {
  generation: number
  notes: readonly PinnedNote[]
  root: string
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
      const reordered = arrayMove([...pinned], activeIndex, overIndex)
      updatePinnedNotesCache(queryClient, graph.root, () => reordered)
      mutate({ generation: graph.generation, notes: reordered, root: graph.root })
    },
    [graph, mutate, pinned, queryClient],
  )
}
