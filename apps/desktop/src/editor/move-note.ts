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

/**
 * Follow a move the index healed by id (Plan 17): an external rename —
 * Finder, Obsidian, a sync pull — already relocated the file, and the
 * reconcile/watcher just moved the rows to match. Carry any live session to
 * the new path and announce, so the route, history, and open pane follow the
 * file exactly as for an in-app rename. No flush and no compensation: the
 * move already happened; this only updates what points at it — and without
 * it, an open pane's next save would resurrect the dead path.
 */
export function followHealedMove(from: string, to: string): void {
  const owner = openSession(from)
  if (owner !== null) {
    owner.retarget(to)
    retargetOpenDocument(from, to, owner)
  }
  emitNoteMoved(from, to)
}
