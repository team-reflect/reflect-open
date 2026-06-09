import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { z } from 'zod'
import { removeFromIndex } from './commands'
import { indexNote } from './indexer'

/**
 * Live re-indexing from the Rust watcher (Plan 04b). The watcher emits batches
 * of {@link FileChange} on `index:changed`; we re-index or remove each at the
 * subscription's `generation`. Late events from a previous graph carry that
 * graph's (now-stale) generation, so Rust drops their writes — the watcher is
 * the sole incremental-reindex path and can't corrupt a newly-opened index.
 */

const fileChangeSchema = z.object({
  path: z.string(),
  kind: z.enum(['upsert', 'remove']),
})
const fileChangesSchema = z.array(fileChangeSchema)

/** A single tracked change reported by the watcher. */
export type FileChange = z.infer<typeof fileChangeSchema>

/** Apply a batch of watcher changes to the index at `generation`. */
export async function applyIndexChanges(changes: FileChange[], generation: number): Promise<void> {
  for (const change of changes) {
    try {
      if (change.kind === 'remove') {
        await removeFromIndex(change.path, generation)
      } else {
        await indexNote(change.path, { generation })
      }
    } catch (err) {
      console.error(`failed to index change for ${change.path}:`, err)
    }
  }
}

/**
 * Subscribe to `index:changed` and apply each batch at `generation`. Returns an
 * unlisten function; call it (and resubscribe with the new generation) when the
 * active graph changes.
 */
export function subscribeIndexChanges(generation: number): Promise<UnlistenFn> {
  // Serialize batches so overlapping events for the same path can't reorder
  // (e.g. an upsert landing after a later remove, leaving a ghost row).
  let applyQueue: Promise<void> = Promise.resolve()
  return listen('index:changed', (event) => {
    const parsed = fileChangesSchema.safeParse(event.payload)
    if (parsed.success) {
      applyQueue = applyQueue
        .then(() => applyIndexChanges(parsed.data, generation))
        .catch((err) => {
          console.error('failed to apply watcher batch:', err)
        })
    }
  })
}
