import { useCallback, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { arrayMove } from '@dnd-kit/sortable'
import type { PinnedNote } from '@reflect/core'
import { reorderPinnedNotes } from '@/lib/note-pin'
import { useGraph } from '@/providers/graph-provider'
import { pinnedNotesQueryKey } from './use-pinned-notes'

export function useReorderPinnedNotes(
  pinned: readonly PinnedNote[],
): (activePath: string, overPath: string) => void {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const saveChain = useRef<Promise<void>>(Promise.resolve())
  const mutationId = useRef(0)

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

      const queryKey = pinnedNotesQueryKey(graph.root)
      const previous = queryClient.getQueryData<PinnedNote[]>(queryKey)
      const currentMutation = mutationId.current + 1
      mutationId.current = currentMutation

      queryClient.setQueryData<PinnedNote[]>(queryKey, reordered)

      saveChain.current = saveChain.current
        .catch(() => undefined)
        .then(() => reorderPinnedNotes(reordered, graph.generation))
        .catch((error: unknown) => {
          if (mutationId.current === currentMutation) {
            if (previous !== undefined) {
              queryClient.setQueryData<PinnedNote[]>(queryKey, previous)
            }
            void queryClient.invalidateQueries({ queryKey })
          }
          console.error('pinned note reorder failed:', error)
        })
    },
    [graph, pinned, queryClient],
  )
}
