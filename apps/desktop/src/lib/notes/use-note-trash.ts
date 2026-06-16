import { useCallback, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { errorMessage, type NoteListEntry } from '@reflect/core'
import { deleteOpenNote } from '@/lib/note-delete'
import { startOperation } from '@/lib/operations'
import { INDEX_QUERY_SCOPE } from '@/lib/query-client'
import { useGraph } from '@/providers/graph-provider'
import { allNotesListPrefix } from './all-notes-query'

export interface NoteTrash {
  /**
   * Move the given notes to the OS trash (desktop) / graph trash (mobile),
   * resolving once every delete has landed. Rejects if any delete fails — the
   * caller surfaces the reason; the optimistic removal is already reconciled.
   */
  trash: (paths: readonly string[]) => Promise<void>
  isTrashing: boolean
}

/**
 * Bulk-trash for the All Notes screen: send a selection of notes to the trash
 * and drop them from the list immediately.
 *
 * Two corrections this path makes over a naive loop of {@link deleteOpenNote}:
 *
 * 1. **Optimistic removal is required, not cosmetic.** On desktop the list only
 *    refreshes when the file watcher's reindex batch applies (`invalidateIndexQueries`),
 *    a visible beat after the delete — the single-note action sidesteps this by
 *    navigating away, but the bulk action stays on the screen. So it removes the
 *    rows from every cached list variant up front (the `all-notes` key prefix —
 *    a trashed note leaves every tag view, not just the active one), then lets
 *    the watcher reconcile. On failure it invalidates rather than restoring a
 *    snapshot: a batch can fail after earlier deletes landed, so refetching truth
 *    is correct where un-removing the lot would not be.
 *
 * 2. **{@link deleteOpenNote}, not raw `deleteNote`.** It discards any open
 *    editor session for the note after the file is gone, so a teardown flush
 *    can't recreate the file. It also guards daily notes (which All Notes never
 *    lists, so this is only defense in depth).
 *
 * Deletes run sequentially: distinct files, so there's no race to avoid, but a
 * sequential loop gives a predictable stop-on-first-failure for the reconcile.
 */
export function useNoteTrash(): NoteTrash {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const [isTrashing, setIsTrashing] = useState(false)

  const trash = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      const generation = graph?.generation
      const root = graph?.root
      if (generation === undefined || root === undefined || paths.length === 0) {
        return
      }
      const removing = new Set(paths)
      const operation = startOperation('Trashing notes')
      setIsTrashing(true)
      queryClient.setQueriesData<NoteListEntry[]>(
        { queryKey: allNotesListPrefix(root) },
        (rows) => rows?.filter((row) => !removing.has(row.path)),
      )
      try {
        for (const path of paths) {
          await deleteOpenNote(path, generation)
        }
        operation.done()
      } catch (cause) {
        operation.fail(errorMessage(cause))
        // Refetch truth: failed and not-yet-attempted notes reappear, the ones
        // already trashed stay gone — a snapshot restore would resurrect them.
        void queryClient.invalidateQueries({ queryKey: [INDEX_QUERY_SCOPE] })
        throw cause
      } finally {
        setIsTrashing(false)
      }
    },
    [graph, queryClient],
  )

  return { trash, isTrashing }
}
