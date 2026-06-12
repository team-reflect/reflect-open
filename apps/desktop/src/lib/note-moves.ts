/**
 * App-global fan-out for note file moves (`docs/readable-filenames.md`). The
 * rename pipeline and the id-healing path emit here after a move lands; the
 * router rewrites its history entries so the current route (and back/forward)
 * follow the file, and the owning pane adopts its retargeted session instead
 * of reloading. Module-level — like the open-documents service — because a
 * move can settle from teardown or quit paths where no pane is mounted.
 */

export type NoteMovedListener = (from: string, to: string) => void

const listeners = new Set<NoteMovedListener>()

/** Subscribe to note moves; returns the unsubscribe. */
export function onNoteMoved(listener: NoteMovedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Announce a landed move to every subscriber. Listeners are isolated: the
 * emit runs inside the rename pipeline's success path, and a throwing
 * subscriber must not get reported as a failed move (the move already
 * landed).
 */
export function emitNoteMoved(from: string, to: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(from, to)
    } catch (cause) {
      console.error('note-moved listener failed:', cause)
    }
  }
}
