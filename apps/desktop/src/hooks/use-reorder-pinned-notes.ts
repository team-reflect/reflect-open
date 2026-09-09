import { useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { arrayMove } from '@dnd-kit/sortable'
import type { PinnedNote } from '@reflect/core'
import { reorderPinnedNotes } from '@/lib/note-pin'
import { mutationKeys, mutationScopeIds, queryKeys } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { planPinReorder, type PinOrderWrite } from '@/lib/notes/pin-order'
import { invalidatePinnedNotesCache, updatePinnedNotesCache } from '@/lib/notes/pinned-notes-cache'

interface ReorderPinnedNotesVariables {
  generation: number
  root: string
  writes: readonly PinOrderWrite[]
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
      reorderPinnedNotes(variables.writes, variables.generation),
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
      const writes = planPinReorder(reordered, activePath)
      const orders = new Map(writes.map((write) => [write.path, write.order]))
      // The new orders go into the cache, not just the new positions: the next
      // drop averages against them while this one is still on its way to disk.
      const next = reordered.map((note) => {
        const order = orders.get(note.path)
        return order === undefined ? note : { ...note, pinnedOrder: order }
      })
      // An in-flight read would otherwise land on top of the new orders, and
      // the next drop would average against the ones it replaced. Not awaited:
      // the shelf has to repaint on this frame.
      void queryClient.cancelQueries({ queryKey: queryKeys.index.pinnedNotes(graph.root) })
      updatePinnedNotesCache(queryClient, graph.root, () => next)
      mutate({ generation: graph.generation, root: graph.root, writes })
    },
    [graph, mutate, pinned, queryClient],
  )
}
