import { moveNoteIndexed } from '@reflect/core'
import { emitNoteMoved } from '@/lib/note-moves'
import { openSession, retargetOpenDocument } from './open-documents'

/**
 * Move a note's file + projection, carrying any live editor session along
 * (Plan 17). Ordering is the mechanism: flush, retarget the session (so a
 * racing save writes the *new* path — Rust keeps the newest bytes if it lands
 * first), re-key the open-documents registry, then move file + index rows in
 * one Rust transaction. A failure retargets back and rethrows; on success
 * every subscriber (the router's history rewrite, adopting panes) hears about
 * it. Shared by the rename pipeline and the 17c migration.
 */
export async function moveNoteCarryingSession(
  from: string,
  to: string,
  generation: number,
): Promise<void> {
  const owner = openSession(from)
  if (owner !== null) {
    await owner.flush()
    owner.retarget(to)
    retargetOpenDocument(from, to)
  }
  try {
    await moveNoteIndexed(from, to, generation)
  } catch (cause) {
    owner?.retarget(from)
    retargetOpenDocument(to, from)
    throw cause
  }
  emitNoteMoved(from, to)
}
