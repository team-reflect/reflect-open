import type { EventName } from '@reflect/types'
import { z } from 'zod'
import type { LoggerService } from '../ports/logger-service.ts'
import type { IndexStoreService } from '../indexing/index-store-service.ts'
import { listenNow, type IpcBridgeService } from '../ipc/ipc-service.ts'
import type { Unlisten } from '../unlisten.ts'
import type { NoteSessionService } from './note-session-types.ts'

/**
 * Event name the Rust move commands emit after their rows commit.
 */
export const NOTE_MOVED_EVENT = 'note:moved' satisfies EventName

const noteMovedSchema = z.object({ from: z.string(), to: z.string() })

/**
 * Hears a landed note move (graph-relative `from` → `to` paths).
 */
export type NoteMovedListener = (from: string, to: string) => void

export interface NoteMoveServiceDeps {
  readonly ipc: IpcBridgeService
  readonly indexStore: IndexStoreService
  readonly noteSessions: NoteSessionService
  readonly logger: LoggerService
}

/**
 * Note file moves (`docs/readable-filenames.md`): the move itself, and the
 * fan-out that tells the rest of the app a note now lives somewhere else. The
 * rename pipeline and the id-healing path announce here after a move lands;
 * the router rewrites its history entries so the current route (and
 * back/forward) follow the file, and the pane keeps the moved session.
 */
export interface NoteMoveService {
  /**
   * Move a note's file + projection, carrying its session along (Plan 17).
   * Ordering is the mechanism: flush, move the session (so any later save
   * writes the *new* path), then move file + index rows in one Rust
   * transaction. A failure — including an occupied destination, which Rust
   * always refuses — moves the session back, then rethrows. On success every
   * subscriber (the router's history rewrite) hears about it. Shared by the
   * rename pipeline and the 17c migration.
   *
   * Retarget-before-move is deliberate. A save can only land mid-move if the
   * user edits inside the single IPC round-trip that follows a flush behind a
   * 5s save-quiet gate (the debounce alone is 800ms — orders of magnitude
   * wider than the window). If that ever happens, the write lands at the
   * destination — where the note is about to live — and the refused move
   * leaves at worst an orphan copy that shares the note's id. The
   * alternative order (retarget after) fails worse: the same race would
   * resurrect the *old* path holding the newest bytes while the index points
   * at the new one. See the plan's risk log (decided 2026-06-11).
   */
  moveNote(from: string, to: string, generation: number): Promise<void>
  /**
   * Follow a move the index healed by id (Plan 17): an external rename —
   * Finder, Obsidian, a sync pull — already relocated the file, and the
   * reconcile/watcher just moved the rows to match. Carry the note's session
   * and its rename coordinator to the new path and announce, so the route,
   * history, and open pane follow the file exactly as for an in-app rename.
   * No flush and no compensation: the move already happened; this only
   * updates what points at it — and without it, the session's next save
   * would resurrect the dead path.
   */
  followHealedMove(from: string, to: string): void
  /**
   * Subscribe to landed note moves; returns the unsubscribe.
   */
  onMoved(listener: NoteMovedListener): Unlisten
  /**
   * Follow the Rust-side "note rows moved" broadcast (`note:moved`), emitted
   * after a rename lands (`note_move_indexed`) or an external move is healed
   * by id (`index_move`), with {@link NoteMoveService.followHealedMove}. The
   * cross-window sibling of the in-process hook: a secondary note window with
   * the note open must retarget its session too, or its next save would
   * resurrect the dead file at the old path. The origin window also followed
   * in-process; the echo is idempotent.
   */
  followNativeMoves(): Unlisten
}

class NoteMoveServiceImpl implements NoteMoveService {
  readonly #deps: NoteMoveServiceDeps
  readonly #listeners = new Set<NoteMovedListener>()

  constructor(deps: NoteMoveServiceDeps) {
    this.#deps = deps
  }

  async moveNote(from: string, to: string, generation: number): Promise<void> {
    const { indexStore, noteSessions } = this.#deps
    const current = await noteSessions.currentSessionFor(from)
    await current?.flush()
    const owner = noteSessions.moveSession(from, to)
    try {
      await indexStore.moveIndexed(from, to, generation)
    } catch (cause) {
      if (owner !== null && noteSessions.existingSessionFor(to) === owner) {
        noteSessions.moveSession(to, from)
      }
      throw cause
    }
    this.#emitMoved(from, to)
  }

  followHealedMove(from: string, to: string): void {
    const { noteSessions } = this.#deps
    noteSessions.moveSession(from, to)
    // The file moved outside the app, so its text may have changed too.
    noteSessions.invalidate(to)
    this.#emitMoved(from, to)
  }

  onMoved(listener: NoteMovedListener): Unlisten {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  followNativeMoves(): Unlisten {
    const { ipc, logger } = this.#deps
    return listenNow(
      () => {
        return ipc.listen(NOTE_MOVED_EVENT, (payload) => {
          const parsed = noteMovedSchema.safeParse(payload)
          if (parsed.success) {
            this.followHealedMove(parsed.data.from, parsed.data.to)
          } else {
            // Contract drift between Rust and TS must be loud — a silently dropped
            // move leaves an open editor writing to a dead path.
            logger.error('invalid note:moved payload:', parsed.error)
          }
        })
      },
      (cause) => {
        logger.warn(`failed to listen for "${NOTE_MOVED_EVENT}"`, cause)
      },
    )
  }

  /**
   * Announce a landed move to every subscriber. Listeners are isolated: the
   * emit runs inside the rename pipeline's success path, and a throwing
   * subscriber must not get reported as a failed move (the move already
   * landed).
   */
  #emitMoved(from: string, to: string): void {
    for (const listener of this.#listeners) {
      try {
        listener(from, to)
      } catch (cause) {
        this.#deps.logger.error('note-moved listener failed:', cause)
      }
    }
  }
}

export function createNoteMoveService(deps: NoteMoveServiceDeps): NoteMoveService {
  return new NoteMoveServiceImpl(deps)
}
