import type { Unlisten } from '../ipc/bridge'
import { moveIndexedRows, removeFromIndex } from './commands'
import { subscribeFileChanges, type FileChange } from './file-changes'
import { indexNote } from './indexer'
import { detectExternalMoves } from './move-healing'
import { getNoteIdsByPath } from './queries'

/**
 * Live re-indexing from the Rust watcher (Plan 04b). Batches of
 * {@link FileChange} arrive on `index:changed`; each is re-indexed or removed
 * at the subscription's `generation`. Late events from a previous graph carry
 * that graph's (now-stale) generation, so Rust drops their writes — the watcher
 * is the sole incremental-reindex path and can't corrupt a newly-opened index.
 */

/** Reports a change that failed to apply; the batch continues past it. */
export type ApplyErrorHandler = (error: unknown, change: FileChange) => void

/**
 * Announces an id-based heal (Plan 17): the rows for an externally renamed
 * note moved `from` → `to`. The desktop layer carries live sessions and
 * rewrites routes off this, exactly as for an in-app rename.
 */
export type MovedHandler = (from: string, to: string) => void

const logApplyError: ApplyErrorHandler = (error, change) => {
  console.error(`failed to index change for ${change.path}:`, error)
}

/**
 * Same-batch external-rename healing (Plan 17): an external rename reaches
 * the watcher as remove(old) + upsert(new) in one debounced batch. When the
 * new file carries the removed row's frontmatter id, move the rows and
 * re-index in place — embedding vectors survive instead of being dropped and
 * re-bought. Returns the handled paths; everything else takes the plain path.
 *
 * Pairs only within a batch: the debouncer groups rename halves in practice,
 * and a split pair degrades to today's delete+create (the orphan row is gone
 * before the arrival shows — nothing left to pair against). Reflect's own
 * `note_move_indexed` echo never pairs: its remove side has no row left.
 */
async function healBatchMoves(
  changes: FileChange[],
  generation: number,
  onError: ApplyErrorHandler,
  onMoved?: MovedHandler,
): Promise<Set<string>> {
  const handled = new Set<string>()
  const removes = changes.filter((change) => change.kind === 'remove')
  const upserts = changes.filter((change) => change.kind === 'upsert')
  if (removes.length === 0 || upserts.length === 0) {
    return handled
  }
  // Orphans: removed paths that still have rows. Arrivals: upserted paths
  // that don't — an upsert of an indexed note is an ordinary edit, never a
  // move target.
  const indexed = await getNoteIdsByPath(upserts.map((change) => change.path))
  const arrivals = upserts.filter((upsert) => !indexed.has(upsert.path))
  const { moves, content } = await detectExternalMoves(
    removes.map((change) => change.path),
    arrivals.map((change) => change.path),
  )
  const mtimeByPath = new Map(arrivals.map((change) => [change.path, change.modifiedMs]))
  for (const move of moves) {
    try {
      await moveIndexedRows(move.from, move.to, generation)
      await indexNote(move.to, {
        generation,
        content: content.get(move.to),
        mtime: mtimeByPath.get(move.to),
      })
      handled.add(move.from)
      handled.add(move.to)
      onMoved?.(move.from, move.to)
    } catch (error) {
      // Unhandled paths fall through to the plain remove/upsert below, which
      // converges (a half-moved row is re-indexed; a missed remove no-ops).
      const change = changes.find((candidate) => candidate.path === move.to)
      onError(error, change ?? { path: move.to, kind: 'upsert' })
    }
  }
  return handled
}

/**
 * Apply a batch of watcher changes to the index at `generation`. Same-batch
 * rename pairs heal as moves first ({@link healBatchMoves}); the rest apply
 * in order. A failing change is reported (default: `console.error`) and
 * skipped, so one unreadable file can't stall the rest of the batch.
 */
export async function applyIndexChanges(
  changes: FileChange[],
  generation: number,
  onError: ApplyErrorHandler = logApplyError,
  onMoved?: MovedHandler,
): Promise<void> {
  let handled: Set<string>
  try {
    handled = await healBatchMoves(changes, generation, onError, onMoved)
  } catch (error) {
    // Healing is best-effort: a failure here (e.g. the id lookup) must not
    // cost the batch — everything degrades to the plain path below.
    console.error('move healing failed; applying the batch plainly:', error)
    handled = new Set()
  }
  for (const change of changes) {
    if (handled.has(change.path)) {
      continue
    }
    try {
      if (change.kind === 'remove') {
        await removeFromIndex(change.path, generation)
      } else {
        await indexNote(change.path, { generation, mtime: change.modifiedMs })
      }
    } catch (error) {
      onError(error, change)
    }
  }
}

/**
 * Subscribe to `index:changed` and apply each batch at `generation`. Returns an
 * unlisten function; call it (and resubscribe with the new generation) when the
 * active graph changes.
 *
 * `onApplied` fires after a batch has been written to the index — the hook for
 * cache invalidation (Plan 07's TanStack Query layer): invalidating on the raw
 * file event would refetch *before* the rows changed.
 */
export function subscribeIndexChanges(
  generation: number,
  onApplied?: (changes: FileChange[]) => void,
  onMoved?: MovedHandler,
): Promise<Unlisten> {
  // Serialize batches so overlapping events for the same path can't reorder
  // (e.g. an upsert landing after a later remove, leaving a ghost row).
  let applyQueue: Promise<void> = Promise.resolve()
  return subscribeFileChanges((changes) => {
    applyQueue = applyQueue
      .then(() => applyIndexChanges(changes, generation, undefined, onMoved))
      .then(() => {
        onApplied?.(changes)
      })
      .catch((error) => {
        console.error('failed to apply watcher batch:', error)
      })
  })
}
