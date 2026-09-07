import { deleteNote, isDaily } from '@reflect/core'
import { openSession } from '@/editor/open-documents'

/**
 * Delete an open regular note and detach its editor session without flushing.
 *
 * `deleteNote` sends the file to the trash — the OS-native trash on desktop, the
 * graph-local `.reflect/trash/` on mobile (which has no OS trash) — recoverable
 * either way, and sync-ignored. The index and queries drop the note once the
 * change lands (the desktop watcher's reindex, or the mobile write echo). Daily
 * notes are intentionally blocked: they are the app's chronological spine and
 * cannot be deleted.
 *
 * The session first pauses persistence and settles its initial load plus any
 * write already in flight. A lazy-created note that still has no backing file
 * is deleted by discarding that session alone. Otherwise delete first, discard
 * second. If the filesystem delete fails, persistence resumes so the mounted
 * editor remains intact. Only once the file is in trash do we discard the
 * session; otherwise a normal teardown flush could recreate the deleted file.
 */
export async function deleteOpenNote(path: string, generation: number): Promise<void> {
  if (isDaily(path)) {
    throw new Error('Daily notes cannot be deleted')
  }
  const session = openSession(path)
  const unpersisted = await session?.prepareDelete()
  if (session !== null && unpersisted === true) {
    session.discard()
    return
  }
  try {
    await deleteNote(path, generation)
  } catch (cause) {
    session?.cancelDelete()
    throw cause
  }
  session?.discard()
  const currentSession = openSession(path)
  if (currentSession !== session) {
    currentSession?.discard()
  }
}
