import { moveNoteIndexed } from '@reflect/core'
import { emitNoteMoved } from '@/lib/note-moves'
import { openSession, retargetOpenDocument } from './open-documents'

/**
 * Move a note's file + projection, carrying any live editor session along
 * (Plan 17). Ordering is the mechanism: flush, retarget the session (so a
 * racing save writes the *new* path — Rust keeps the newest bytes if it lands
 * first), re-key the open-documents registry, then move file + index rows in
 * one Rust transaction. A failure undoes exactly what was done — the session
 * retargets back only if one was carried, and the registry re-key is
 * identity-guarded so it can never grab a different pane's document — then
 * rethrows. On success every subscriber (the router's history rewrite,
 * adopting panes) hears about it. Shared by the rename pipeline and the 17c
 * migration.
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
    retargetOpenDocument(from, to, owner)
  }
  try {
    await moveNoteIndexed(from, to, generation)
  } catch (cause) {
    if (owner !== null) {
      owner.retarget(from)
      retargetOpenDocument(to, from, owner)
    }
    throw cause
  }
  emitNoteMoved(from, to)
}
