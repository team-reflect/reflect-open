import type { Unlisten } from '../ipc/bridge'
import { isAssetPath, isNotePath } from '../graph/paths'
import { readNote } from '../graph/commands'
import { moveIndexedRows, removeFromIndex } from './commands'
import { subscribeFileChanges, type FileChange } from './file-changes'
import { hashContent, matchesTrustedMtime } from './hash'
import { emitIndexApplied } from './index-applied'
import {
  buildNoteProjection,
  createIndexApplyBatch,
  createMtimeTouchBatch,
  indexNote,
} from './indexer'
import { detectExternalMoves } from './move-healing'
import { INDEX_PASS_YIELD_EVERY, yieldToEventLoop } from './pacing'
import { getIndexedFileFactsByPath, getNoteIdsByPath, type IndexedFileFacts } from './queries'

/**
 * Live re-indexing from the Rust watcher (Plan 04b). Batches of
 * {@link FileChange} arrive on `index:changed`; each is re-indexed or removed
 * at the subscription's `generation`. Late events from a previous graph carry
 * that graph's (now-stale) generation, so Rust drops their writes — the watcher
 * is the sole incremental-reindex path and can't corrupt a newly-opened index.
 *
 * Batches can be large — the iCloud metadata query's initial gather reports
 * every downloaded note at once — so applying is batch-shaped end to end:
 * stored facts are prefetched in one query, files whose indexed mtime already
 * matches are skipped without a read, hash-unchanged reads skip the write,
 * changed notes land in shared `index_apply_batch` transactions, and the loop
 * takes an event-loop break every {@link INDEX_PASS_YIELD_EVERY} files.
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
): Promise<{ handled: Set<string>; healed: number }> {
  const handled = new Set<string>()
  let healed = 0
  const removes = changes.filter((change) => change.kind === 'remove')
  const upserts = changes.filter((change) => change.kind === 'upsert')
  if (removes.length === 0 || upserts.length === 0) {
    return { handled, healed }
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
      healed += 1
      onMoved?.(move.from, move.to)
    } catch (error) {
      // Unhandled paths fall through to the plain remove/upsert below, which
      // converges (a half-moved row is re-indexed; a missed remove no-ops).
      const change = changes.find((candidate) => candidate.path === move.to)
      onError(error, change ?? { path: move.to, kind: 'upsert' })
    }
  }
  return { handled, healed }
}

/**
 * Stored facts for the batch's upsert paths, so unchanged files can skip
 * without a read. Best-effort: on failure every file simply takes the full
 * read-and-hash path, which converges regardless.
 */
async function prefetchFacts(paths: string[]): Promise<Map<string, IndexedFileFacts>> {
  if (paths.length === 0) {
    return new Map()
  }
  try {
    return await getIndexedFileFactsByPath(paths)
  } catch (error) {
    console.error('stored-facts prefetch failed; applying the batch without skips:', error)
    return new Map()
  }
}

/**
 * Apply a batch of watcher changes to the index at `generation`. Same-batch
 * rename pairs heal as moves first ({@link healBatchMoves}); the rest apply
 * in order. A failing change is reported (default: `console.error`) and
 * skipped, so one unreadable file can't stall the rest of the batch.
 *
 * Returns how many index mutations the batch actually performed (applies,
 * removes, and healed moves). Zero means every change was already reflected
 * in the index — the caller can skip its cache invalidation.
 */
export async function applyIndexChanges(
  changes: FileChange[],
  generation: number,
  onError: ApplyErrorHandler = logApplyError,
  onMoved?: MovedHandler,
): Promise<number> {
  // The change stream carries more than notes (the watcher also reports
  // audio-memo recordings); only markdown notes reach the index.
  const notes = changes.filter((change) => isNotePath(change.path))
  if (notes.length === 0) {
    return 0
  }
  let handled: Set<string>
  let mutations = 0
  try {
    const outcome = await healBatchMoves(notes, generation, onError, onMoved)
    handled = outcome.handled
    mutations += outcome.healed
  } catch (error) {
    // Healing is best-effort: a failure here (e.g. the id lookup) must not
    // cost the batch — everything degrades to the plain path below.
    console.error('move healing failed; applying the batch plainly:', error)
    handled = new Set()
  }

  const stored = await prefetchFacts(
    notes
      .filter((change) => change.kind === 'upsert' && !handled.has(change.path))
      .map((change) => change.path),
  )
  const now = Date.now()
  const changeByPath = new Map(notes.map((change) => [change.path, change]))
  // A write refused even alone (after the batcher's halving retry) reports
  // through the batch's own error channel, mapped back to its change.
  const batch = createIndexApplyBatch(generation, (skipped) => {
    onError(
      new Error(skipped.message),
      changeByPath.get(skipped.path) ?? { path: skipped.path, kind: 'upsert' },
    )
  })
  const touches = createMtimeTouchBatch(generation)

  let done = 0
  for (const change of notes) {
    done += 1
    if (done % INDEX_PASS_YIELD_EVERY === 0) {
      await yieldToEventLoop()
    }
    if (handled.has(change.path)) {
      continue
    }
    try {
      if (change.kind === 'remove') {
        // Flush first: a same-batch upsert(x) … remove(x) sequence must not
        // have the batched upsert land *after* the remove and resurrect it.
        await batch.flush()
        await removeFromIndex(change.path, generation)
        mutations += 1
        continue
      }
      const facts = stored.get(change.path)
      if (matchesTrustedMtime(facts?.mtime, change.modifiedMs, now)) {
        continue // already indexed at this mtime — e.g. the watch's initial gather
      }
      const content = await readNote(change.path)
      const fileHash = await hashContent(content)
      if (facts?.fileHash === fileHash) {
        // Content unchanged; only the mtime moved. Re-stamp the row so the
        // next pass skips the read — a stored echo-time stamp never matches
        // and would cost this read on every reconcile and every batch.
        if (change.modifiedMs !== undefined && facts.mtime !== change.modifiedMs) {
          await touches.add({ path: change.path, mtime: change.modifiedMs })
        }
        continue
      }
      await batch.add(
        await buildNoteProjection(change.path, content, {
          fileHash,
          mtime: change.modifiedMs ?? Date.now(),
        }),
      )
    } catch (error) {
      onError(error, change)
    }
  }
  await batch.flush()
  await touches.flush()
  // Re-stamps count as mutations: `updated_at` moved, so recency-ordered
  // queries may return different rows and the caller must invalidate.
  return mutations + batch.applied() + touches.applied()
}

/**
 * Subscribe to `index:changed` and apply each batch at `generation`. Returns an
 * unlisten function; call it (and resubscribe with the new generation) when the
 * active graph changes.
 *
 * `onApplied` fires after a batch's note rows have been written to the index —
 * the hook for cache invalidation (Plan 07's TanStack Query layer): invalidating
 * on the raw file event would refetch *before* the rows changed. A batch whose
 * changes were all already reflected (mtime/hash skips) fires nothing — there
 * is nothing new to refetch.
 *
 * After the same apply step, {@link emitIndexApplied} broadcasts the **full**
 * batch (notes *and* asset-file changes) to its subscribers — the seam the
 * asset-description controller (Plan 20) uses so its privacy gate always reads a
 * settled index, never racing a just-written private note's indexing. Batches
 * that touch neither notes nor assets (e.g. audio-memo recordings) are skipped
 * entirely, as before.
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
    const notes = changes.filter((change) => isNotePath(change.path))
    const touchesAssets = changes.some((change) => isAssetPath(change.path))
    if (notes.length === 0 && !touchesAssets) {
      return // e.g. a batch of audio-memo recordings — nothing the index tracks
    }
    applyQueue = applyQueue
      .then(() => (notes.length > 0 ? applyIndexChanges(notes, generation, undefined, onMoved) : 0))
      .then((mutations) => {
        if (notes.length > 0 && mutations > 0) {
          onApplied?.(notes)
        }
        // Post-apply: the asset-description controller reads the now-settled
        // index off this. Carries the full batch (notes + asset files) and the
        // `generation` so a consumer can drop a stale emit from a graph it has
        // switched away from. Chained on the same queue, so any prior note apply
        // is visible before an asset-only batch's gate runs.
        emitIndexApplied(changes, generation)
      })
      .catch((error) => {
        console.error('failed to apply watcher batch:', error)
      })
  })
}
