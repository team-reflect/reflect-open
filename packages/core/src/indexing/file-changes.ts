import { z } from 'zod'
import { getBridge, type Unlisten } from '../ipc/bridge'

/**
 * The `index:changed` event stream from the Rust file watcher (Plan 04b): the
 * subscription primitive only — payload validation and fan-out to a handler.
 * What to *do* with a change lives one layer up (`live.ts` re-indexes; the
 * editor reconciles the open note).
 */

/** Event name the Rust watcher emits tracked-file changes on. */
export const FILE_CHANGES_EVENT = 'index:changed'

const fileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
  /**
   * The file's last-modified time (epoch ms), present on upserts. The re-index
   * path stamps `notes.mtime` from it; removes (and older payloads) omit it.
   */
  modifiedMs: z.number().optional(),
})
const fileChangesSchema = z.array(fileChangeSchema)

/** A single tracked change reported by the watcher. */
export type FileChange = z.infer<typeof fileChangeSchema>

/** Subscribers also reachable by {@link emitFileChanges} (sync-applied writes). */
const localHandlers = new Set<(changes: FileChange[]) => void>()

/**
 * Subscribe to file-change batches: the watcher's {@link FILE_CHANGES_EVENT}
 * (zod-validated) plus batches produced in-process via
 * {@link emitFileChanges}. The general notification primitive: the indexing
 * subscription builds on it, and the editor (Plan 05) uses it for
 * external-change reconciliation of the open note.
 */
export function subscribeFileChanges(
  handler: (changes: FileChange[]) => void,
): Promise<Unlisten> {
  localHandlers.add(handler)
  return getBridge()
    .listen(FILE_CHANGES_EVENT, (payload) => {
      const parsed = fileChangesSchema.safeParse(payload)
      if (parsed.success) {
        handler(parsed.data)
      } else {
        // A malformed payload means the Rust↔TS event contract drifted — loud
        // beats silently-stale indexes and editors.
        console.error('invalid index:changed payload:', parsed.error)
      }
    })
    .then(
      (unlisten) => () => {
        localHandlers.delete(handler)
        unlisten()
      },
      (error: unknown) => {
        localHandlers.delete(handler)
        throw error
      },
    )
}

/**
 * Event name the Rust watcher emits when only a full reconcile can tell what
 * changed: a visible folder was created, renamed, or removed, and no platform
 * enumerates its descendants per file. Carries no payload.
 */
export const RECONCILE_EVENT = 'index:reconcile'

/**
 * Subscribe to the watcher's coarse reconcile demands. The handler should
 * trigger the ordinary full index refresh (re-list, hash-gate, prune) — the
 * pass is content-hash gated, so over-asking costs a listing, not a re-parse.
 */
export function subscribeReconcileRequests(handler: () => void): Promise<Unlisten> {
  return getBridge().listen(RECONCILE_EVENT, () => handler())
}

/**
 * Fan a locally produced batch (files a sync merge just wrote, Plan 12) to
 * every subscriber, exactly as if the watcher had reported it. Pull-applied
 * writes must reach open editors and the index even when the Rust watcher
 * isn't running yet — the launch pull can land before watch start, and an
 * unnotified open editor would overwrite the merged content on its next save.
 */
export function emitFileChanges(changes: FileChange[]): void {
  for (const handler of [...localHandlers]) {
    handler(changes)
  }
}
