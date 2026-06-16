import type { FileChange } from './file-changes'

/**
 * The post-index "batch applied" signal (Plan 20 search/privacy closure).
 *
 * The live indexer ({@link subscribeIndexChanges}) emits here **after** a
 * watcher batch has been written to the index — so a subscriber that reads the
 * index sees the batch's note rows (privacy flags, `assets` projection) already
 * settled, never a stale snapshot. The asset-description controller drives its
 * privacy gate off this rather than the raw `index:changed` stream, closing the
 * race where the gate could run before a just-written private note was indexed.
 *
 * In-process only (no IPC): both the emitter and the subscriber live in the
 * frontend. The payload is the full batch — note changes *and* asset-file
 * changes — so the consumer filters for what it cares about. The batch's
 * `generation` (the issuing graph session) rides along so a consumer pinned to a
 * graph can ignore a delayed emit from a graph it has since switched away from.
 */

/**
 * A listener for applied watcher batches; receives the full batch and the
 * `generation` (graph session) it was applied at, post-index.
 */
export type IndexAppliedListener = (changes: readonly FileChange[], generation: number) => void

const listeners = new Set<IndexAppliedListener>()

/**
 * Subscribe to post-index batch-applied notifications. Returns an unsubscribe
 * function. Listeners that pin to a graph session must compare `generation`
 * themselves and ignore mismatches (a stale emit from the previous graph).
 */
export function subscribeIndexApplied(listener: IndexAppliedListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Notify subscribers that `changes` were applied to the index at `generation`. */
export function emitIndexApplied(changes: readonly FileChange[], generation: number): void {
  for (const listener of [...listeners]) {
    listener(changes, generation)
  }
}
