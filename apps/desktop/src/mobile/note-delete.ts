import { deleteNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/**
 * Delete a note from the mobile note screen (Plan 19, V1 parity). On mobile
 * `deleteNote` moves the file into the graph-local `.reflect/trash/`
 * (recoverable, sync-ignored) and emits the in-process `remove` so the index
 * and queries drop it.
 *
 * The note is open in the editor, so its session is **discarded** first: a
 * normal dispose flushes, which would rewrite — and recreate — the file we're
 * deleting (especially with unsaved edits). `discard` detaches without
 * writing, and the pane's later unmount-dispose stays a no-op. The caller
 * navigates away after this resolves.
 */
export async function deleteOpenNote(path: string, generation: number): Promise<void> {
  openSession(path)?.discard()
  await deleteNote(path, generation)
}
