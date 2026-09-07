/**
 * Quit-time backup seam. The backup controller registers a flusher (a local
 * `git commit` of anything dirty — never a network push, which could stall
 * the quit) while a graph is connected; `quit-flush.ts` runs it after the
 * note buffers have landed so the final commit captures them. Errors are
 * swallowed: refusing to quit would trap the user, and anything uncommitted
 * is picked up by the next launch's sync cycle anyway.
 */

let flusher: (() => Promise<void>) | null = null

/** Install a graph's quit-commit hook; release only this registration on teardown. */
export function registerBackupFlusher(next: () => Promise<void>): () => void {
  flusher = next
  return () => {
    if (flusher === next) {
      flusher = null
    }
  }
}

/** Run the registered quit-commit, if any. Never throws, never blocks quit. */
export async function flushBackup(): Promise<void> {
  try {
    await flusher?.()
  } catch {
    // Surfaced on the next launch's sync instead.
  }
}
