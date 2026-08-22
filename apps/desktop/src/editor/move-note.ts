import { moveNoteIndexed } from '@reflect/core'
import { emitNoteMoved } from '@/lib/note-moves'
import { openSession, retargetOpenDocument } from './open-documents'

/**
 * Move a note's file + projection, carrying any live editor session along
 * (Plan 17). Ordering is the mechanism: flush, retarget the session (so any
 * later save writes the *new* path), re-key the open-documents registry, then
 * move file + index rows in one Rust transaction. A failure — including an
 * occupied destination, which Rust always refuses — restores the registry
 * and attempts to retarget the session back before rethrowing the original
 * move error. If native ownership cannot be restored, the session is
 * discarded so it can never write through its now-wrong path. On success
 * every subscriber (the router's history rewrite, adopting panes) hears
 * about it. Shared by the rename pipeline and the 17c migration.
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
    await owner.retarget(to)
    retargetOpenDocument(from, to, owner)
  }
  try {
    await moveNoteIndexed(from, to, generation)
  } catch (cause) {
    if (owner !== null) {
      try {
        await owner.retarget(from)
      } catch {
        // The file is still at `from`, while the session may still target
        // `to`. Freeze it rather than allow a later save to create the wrong
        // file; the original move failure remains the caller-facing cause.
        try {
          owner.discard()
        } catch {
          // Preserve the original move failure even if a test seam or future
          // session implementation makes fail-closed cleanup fallible.
        }
      } finally {
        // Repair lookup identity even when native ownership rollback fails.
        retargetOpenDocument(to, from, owner)
        void owner.releaseRetargetedPath(to).catch(() => {})
      }
    }
    throw cause
  }
  if (owner !== null) {
    void owner.releaseRetargetedPath(from).catch(() => {})
  }
  emitNoteMoved(from, to)
}

/**
 * Follow a move the index healed by id (Plan 17): an external rename —
 * Finder, Obsidian, a sync pull — already relocated the file, and the
 * reconcile/watcher just moved the rows to match. Carry any live session to
 * the new path and announce, so the route, history, and open pane follow the
 * file exactly as for an in-app rename. The move already happened, so its
 * announcement is unconditional. If native ownership cannot follow it, the
 * stale session is discarded before announcing; the routed pane then opens a
 * fresh session at `to` instead of resurrecting `from` on its next save.
 */
export async function followHealedMove(from: string, to: string): Promise<void> {
  const owner = openSession(from)
  try {
    if (owner !== null) {
      await owner.retarget(to)
      retargetOpenDocument(from, to, owner)
      void owner.releaseRetargetedPath(from).catch(() => {})
    }
  } catch {
    // Disk and index already agree on `to`; a session that still targets
    // `from` must be prevented from flushing there while routes catch up.
    try {
      owner?.discard()
    } catch {
      // The move announcement is the authoritative state transition and must
      // not be suppressed by best-effort local cleanup.
    }
  } finally {
    emitNoteMoved(from, to)
  }
}
