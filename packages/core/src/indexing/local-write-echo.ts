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

/**
 * Emit `change` to the in-process file-change channel when echoes are
 * enabled; a no-op on desktop. Write commands call this after their write
 * has landed, so a consumer that re-reads the file always sees the new
 * contents.
 */
export function echoLocalWrite(change: FileChange): void {
  if (echoEnabled) {
    emitFileChanges([change])
  }
}
