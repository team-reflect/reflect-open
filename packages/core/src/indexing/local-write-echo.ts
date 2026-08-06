import { emitFileChanges, type FileChange } from './file-changes'

/**
 * The mobile stand-in for the file watcher's echo (Plan 19, decision 5).
 *
 * On desktop every local write flows file → watcher → `index:changed`, and
 * the whole derived layer hangs off that event: incremental reindex, query
 * invalidation, the sync engine's dirty mark, and open-editor
 * reconciliation. Mobile has no watcher — nothing else writes the app
 * sandbox — so the write commands themselves emit the equivalent change
 * batch in-process (`emitFileChanges`) once a write lands. Consumers cannot
 * tell the difference; the editor recognizes its own save as an echo by
 * content, exactly as it does a watcher event.
 *
 * Off by default: the desktop watcher already covers local writes there.
 * The mobile root enables it once at boot, before any write can happen.
 */
let echoEnabled = false

/**
 * Turn local write echoes on or off. The mobile root chunk enables them at
 * module load; tests reset to `false` between cases.
 */
export function setLocalWriteEcho(enabled: boolean): void {
  echoEnabled = enabled
}

const ownWriteListeners = new Set<(path: string) => void>()

/**
 * Observe this device's own note/asset writes, on every platform — unlike
 * the file-change echo, this fires regardless of {@link setLocalWriteEcho}.
 * The iCloud sync controller (Plan 21) uses it to tell its own writes apart
 * from external arrivals: only external content may advance a note's shadow
 * merge base, and a watcher event alone can't make that distinction.
 */
export function subscribeOwnWrites(handler: (path: string) => void): () => void {
  ownWriteListeners.add(handler)
  return () => {
    ownWriteListeners.delete(handler)
  }
}

/**
 * Emit `change` to the in-process file-change channel when echoes are
 * enabled; a no-op on desktop. Write commands call this after their write
 * has landed, so a consumer that re-reads the file always sees the new
 * contents. Own-write observers ({@link subscribeOwnWrites}) are notified
 * unconditionally.
 */
export function echoLocalWrite(change: FileChange): void {
  for (const handler of ownWriteListeners) {
    try {
      handler(change.path)
    } catch (err) {
      // One misbehaving observer must not break the write echo for everyone.
      console.error('own-write observer failed:', err)
    }
  }
  if (echoEnabled) {
    emitFileChanges([change])
  }
}
