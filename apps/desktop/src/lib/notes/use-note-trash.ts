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
   * Trash the given notes, resolving with the paths that could **not** be
   * trashed (empty = every note went to the trash).
   *
   * A per-note failure does not abort the batch — the rest still go — and the
   * failures are returned rather than thrown, so the caller can retry just the
   * leftovers. That matters because the OS trash isn't idempotent: re-deleting
   * a note already moved to the trash errors, so a retry must never re-attempt
   * the ones that already succeeded.
   *
   * Rejects (rather than resolving) only when there's no graph to trash into —
   * a precondition failure the caller should surface, not a silent no-op.
   */
  trash: (paths: readonly string[]) => Promise<readonly string[]>
  isTrashing: boolean
}

/**
 * Bulk-trash for the All Notes screen: send a selection of notes to the trash
 * and drop them from the list immediately.
 *
 * Three things this path gets right that a naive loop wouldn't:
 *
 * 1. **Optimistic removal is required, not cosmetic.** On desktop the list only
 *    refreshes when the file watcher's reindex batch applies — a visible beat
 *    after the delete. The single-note action sidesteps this by navigating
 *    away; the bulk action stays on the screen, so it removes the rows from
 *    every cached list variant (the `all-notes` key prefix — a trashed note
 *    leaves every tag view) up front, then lets the watcher reconcile. On any
 *    failure it invalidates to refetch truth: the still-present notes reappear,
 *    the trashed ones stay gone — un-removing the lot would be wrong.
 *
 * 2. **{@link deleteOpenNote}, not raw `deleteNote`.** It discards any open
 *    editor session for the note after the file is gone, so a teardown flush
 *    can't recreate the file. It also guards daily notes (which All Notes never
 *    lists, so this is only defense in depth).
 *
 * 3. **Per-note failures are isolated.** Deletes run sequentially (distinct
 *    files, so no race to avoid, but it keeps progress legible) and one failing
 *    note doesn't strand the rest; the failures come back for a clean retry.
 */
export function useNoteTrash(): NoteTrash {
  const { graph } = useGraph()
  const queryClient = useQueryClient()
  const [isTrashing, setIsTrashing] = useState(false)

  const trash = useCallback(
    async (paths: readonly string[]): Promise<readonly string[]> => {
      if (paths.length === 0) {
        return []
      }
      const generation = graph?.generation
      const root = graph?.root
      if (generation === undefined || root === undefined) {
        // No graph to trash into — surface it; never report a silent success.
        throw new Error('No graph is open.')
      }
      const removing = new Set(paths)
      const operation = startOperation('Trashing notes')
      setIsTrashing(true)
      queryClient.setQueriesData<NoteListEntry[]>(
        { queryKey: allNotesListPrefix(root) },
        (rows) => rows?.filter((row) => !removing.has(row.path)),
      )
      const failed: string[] = []
      let lastError: unknown = null
      try {
        operation.progress(0, paths.length)
        let attempted = 0
        for (const path of paths) {
          try {
            await deleteOpenNote(path, generation)
          } catch (cause) {
            lastError = cause
            failed.push(path)
          }
          attempted += 1
          operation.progress(attempted, paths.length)
        }
        if (failed.length > 0) {
          operation.fail(errorMessage(lastError))
          // Reconcile to truth: the notes that failed (still on disk) reappear,
          // the ones that were trashed stay gone.
          void queryClient.invalidateQueries({ queryKey: [INDEX_QUERY_SCOPE] })
        } else {
          operation.done()
        }
        return failed
      } finally {
        setIsTrashing(false)
      }
    },
    [graph, queryClient],
  )

  return { trash, isTrashing }
}
