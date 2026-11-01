import { useCallback } from 'react'
import { useCoreServices } from '@/services/services-provider.tsx'

export interface NoteTrash {
  /**
   * Trash the given notes, resolving `true` when **every** note went to the
   * trash and `false` when any could not. Failures — a per-note error or a
   * missing graph — are reported through the operations toast
   * (`OperationsService.start`), the app's standard channel for background work,
   * rather than thrown: the caller only needs to know whether it fully
   * succeeded (to clear the selection) and can close its confirm either way.
   */
  trash: (paths: readonly string[]) => Promise<boolean>
}

/**
 * Bulk-trash for the All Notes screen: send a selection of notes to the trash.
 *
 * - **Each row leaves the list as its delete lands.** `trashMany` marks each
 *   trashed note in the note-row overlay, which the list merges, so the row
 *   goes before the watcher's reindex. A failed note stays in the list, and
 *   therefore in the selection (which prunes only vanished rows), so the user
 *   can retry it without re-selecting.
 * - **`NoteActionsService.trashMany`, not raw `deleteNote`.** It discards any
 *   open editor session for the note after the file is gone, so a teardown
 *   flush can't recreate the file. It also guards daily notes as defense in
 *   depth; All Notes filters them out of the selected trash targets before
 *   calling.
 * - **Per-note failures don't strand the rest.** Deletes run sequentially and a
 *   failure is recorded, not rethrown mid-batch, so the remaining notes still
 *   trash; the toast reports the count couldn't-trash via the last error.
 */
export function useNoteTrash(): NoteTrash {
  const { noteActions } = useCoreServices()

  const trash = useCallback(
    async (paths: readonly string[]): Promise<boolean> => {
      if (paths.length === 0) {
        return true
      }
      const { failed } = await noteActions.trashMany(paths)
      return failed.length === 0
    },
    [noteActions],
  )

  return { trash }
}
