import { moveNoteIndexed } from '@reflect/core'
import { emitNoteMoved } from '@/lib/note-moves'
import { openSession, retargetOpenDocument } from './open-documents'

/**
 * Move a note's file + projection, carrying any live editor session along
 * (Plan 17). Ordering is the mechanism: flush, retarget the session (so any
 * later save writes the *new* path), re-key the open-documents registry, then
 * move file + index rows in one Rust transaction. A failure — including an
 * occupied destination, which Rust always refuses — undoes exactly what was
 * done: the session retargets back only if one was carried, and the registry
 * re-key is identity-guarded so it can never grab a different pane's
 * document; then it rethrows. On success every subscriber (the router's
 * history rewrite, adopting panes) hears about it. Shared by the rename
 * pipeline and the 17c migration.
 *
 * Retarget-before-move is deliberate. A save can only land mid-move if the
 * user edits inside the single IPC round-trip that follows a flush behind a
 * 5s save-quiet gate (the debounce alone is 800ms — orders of magnitude
 * wider than the window). If that ever happens, the write lands at the
 * destination — where the note is about to live — and the refused move
 * leaves at worst an orphan copy the duplicate-id surface flags. The
 * alternative order (retarget after) fails worse: the same race would
 * resurrect the *old* path holding the newest bytes while the index points
 * at the new one. See the plan's risk log (decided 2026-06-11).
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
    // The watcher batch that healed the move contains a remove for `from` and
    // an upsert for `to`. The editor saw the remove while it was still bound
    // to the old path, so prove the retargeted file exists and release that
    // removal park now; otherwise its next edit would stay blocked forever.
    owner.externalChanged()
  }
  emitNoteMoved(from, to)
}
