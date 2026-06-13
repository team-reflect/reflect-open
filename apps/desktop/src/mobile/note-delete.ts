import { deleteNote } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/**
 * Delete a note from the mobile note screen (Plan 19, V1 parity). On mobile
 * `deleteNote` moves the file into the graph-local `.reflect/trash/`
 * (recoverable, sync-ignored) and emits the in-process `remove` so the index
 * and queries drop it.
 *
 * **Delete first, discard second.** If the delete fails, the open session is
 * left fully intact — the note screen stays mounted and editable, edits keep
 * persisting. Only once the file is in trash do we `discard` the session: it
 * stays `dirty` after its file vanishes (a removed file is "nothing to
 * reconcile", so dirtiness isn't cleared), and a normal teardown flush would
 * therefore rewrite — recreate — the file. `discard` detaches without
 * writing, so the pane's unmount (flush → dispose) is a no-op. The caller
 * navigates away after this resolves.
 */
export async function deleteOpenNote(path: string, generation: number): Promise<void> {
  await deleteNote(path, generation)
  openSession(path)?.discard()
}
