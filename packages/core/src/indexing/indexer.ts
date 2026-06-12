import { isAppError } from '../errors'
import { listFiles, readNote } from '../graph/commands'
import { parseNote } from '../markdown'
import {
  applyIndexedNote,
  applyIndexedNotes,
  clearIndex,
  moveIndexedRows,
  removeFromIndex,
  setIndexMeta,
} from './commands'
import { hashContent } from './hash'
import { buildIndexedNote, PROJECTION_VERSION, type IndexedNote } from './indexed-note'
import { pairMovesById } from './move-detection'
import { getIndexedHashes, getIndexMeta, getNoteIdsByPath } from './queries'

/**
 * The indexing pipeline (Plan 04): read (Plan 02) → parse/extract in TS
 * (Plan 03) → hash → hand the flattened projection to Rust, which applies it in
 * one transaction. The index is a rebuildable cache.
 *
 * Every write carries the index `generation` returned by `openIndex`. Rust
 * no-ops a write whose generation is stale, so a pass started for one graph can
 * never mutate a newly-opened index — cancellation is correct regardless of
 * caller timing (the watcher in Plan 04b indexes outside the serialized open
 * flow). The `AbortSignal` is an optimization that stops a superseded pass early.
 */

/**
 * Notes per `index_apply_batch` transaction during a full rebuild. Bounds the
 * IPC payload and transaction size on large graphs while keeping the
 * transaction/round-trip count far below one-per-note.
 */
const REBUILD_BATCH_SIZE = 256

/**
 * The `index_meta` key holding the {@link PROJECTION_VERSION} the stored rows
 * were built with. Stamped after every full rebuild; `index_clear` preserves
 * `index_meta`, and the stamp is rewritten once the rebuild completes.
 */
export const PROJECTION_VERSION_KEY = 'projection_version'

/**
 * Read, parse, and (re)index a single note for the given index generation.
 * Without an explicit `mtime` the row is stamped "now" — a watcher event means
 * the file just changed, and a real timestamp beats epoch zero (which would
 * sink the note to the bottom of every recency sort and, because reconcile is
 * content-hash gated, never get repaired).
 */
export async function indexNote(
  path: string,
  options: { generation: number; content?: string; mtime?: number },
): Promise<void> {
  const content = options.content ?? (await readNote(path))
  const parsed = parseNote({ path, source: content })
  const fileHash = await hashContent(content)
  await applyIndexedNote(
    buildIndexedNote(parsed, { fileHash, mtime: options.mtime ?? Date.now(), source: content }),
    options.generation,
  )
}

/** Options for the long-running index passes. */
export interface IndexPassOptions {
  /** The index generation from `openIndex`; stale writes are dropped by Rust. */
  generation: number
  /** Aborts the pass early when the active graph changes. */
  signal?: AbortSignal
}

/**
 * Full rebuild: wipe derived tables and re-index every markdown file. Used for
 * explicit repair / schema-bump triggers, not the hot graph-switch path (that's
 * {@link reconcileIndex}). Abort is checked **only before** the wipe — once we've
 * cleared, we run to completion so an interrupted rebuild can't leave the index
 * empty or half-populated.
 */
export async function rebuildIndex(options: IndexPassOptions): Promise<void> {
  const { generation } = options
  if (options.signal?.aborted) {
    return // don't wipe the current index for an already-cancelled pass
  }
  await clearIndex(generation)
  const files = await listFiles()
  let batch: IndexedNote[] = []
  for (const file of files) {
    const content = await readNote(file.path)
    const parsed = parseNote({ path: file.path, source: content })
    const fileHash = await hashContent(content)
    batch.push(buildIndexedNote(parsed, { fileHash, mtime: file.modifiedMs, source: content }))
    if (batch.length >= REBUILD_BATCH_SIZE) {
      await applyIndexedNotes(batch, generation)
      batch = []
    }
  }
  await applyIndexedNotes(batch, generation)
  // The rows now match the current projection — stamp it so `syncIndex` can
  // reconcile cheaply from here on. A superseded pass stamps into a stale
  // generation, which Rust drops: the next open then rebuilds again, which is
  // the safe direction to fail in.
  await setIndexMeta(PROJECTION_VERSION_KEY, String(PROJECTION_VERSION), generation)
}

/**
 * The open-path sync: hash-reconcile when the stored rows were built by the
 * current {@link PROJECTION_VERSION}, full rebuild when they weren't (an older
 * app wrote them, or the index has never been stamped). Reconcile compares
 * content hashes only, so it can never refresh rows whose *derivation* changed
 * — without this gate, columns added by a migration would keep their defaults
 * forever on unchanged files.
 */
export async function syncIndex(options: IndexPassOptions): Promise<void> {
  const stamped = await getIndexMeta(PROJECTION_VERSION_KEY)
  if (stamped === String(PROJECTION_VERSION)) {
    return reconcileIndex(options)
  }
  return rebuildIndex(options)
}

/**
 * Reconcile the index with disk (the open path): re-index files whose content
 * hash changed, and drop rows for files that no longer exist. Cheaper than a full
 * rebuild on an already-populated index, and abortable on graph switch. Writes
 * carry `generation`, so even a pass that races a connection swap can't corrupt
 * the newly-opened index — Rust drops its stale writes.
 */
export async function reconcileIndex(options: IndexPassOptions): Promise<void> {
  const { generation, signal } = options
  const files = await listFiles()
  if (signal?.aborted) {
    return
  }
  const onDisk = new Set(files.map((file) => file.path))
  const stored = await getIndexedHashes()

  // Id-based move healing (Plan 17): a row whose file vanished plus a new
  // file carrying the same frontmatter id is a rename observed after the
  // fact — an external tool or a sync pull moved it while Reflect wasn't
  // looking. Move the rows instead of delete+create, so embedding vectors
  // survive (re-embedding identical content costs the user BYOK money).
  // Ambiguous ids (a rename/rename fork) never pair — the duplicate-id
  // surface reports those for review.
  const orphanPaths = [...stored.keys()].filter((path) => !onDisk.has(path))
  const arrivalFiles = files.filter((file) => !stored.has(file.path))
  /** Arrival content read for pairing — the main pass below reuses it. */
  const arrivalContent = new Map<string, string>()
  if (orphanPaths.length > 0 && arrivalFiles.length > 0) {
    const orphanIds = await getNoteIdsByPath(orphanPaths)
    const arrivalIds = new Map<string, string | null>()
    for (const file of arrivalFiles) {
      if (signal?.aborted) {
        return
      }
      try {
        const content = await readNote(file.path)
        arrivalContent.set(file.path, content)
        const parsed = parseNote({ path: file.path, source: content })
        arrivalIds.set(file.path, parsed.frontmatter.id ?? null)
      } catch {
        // Unreadable arrival: it can't pair; the main pass retries the read.
      }
    }
    for (const move of pairMovesById(orphanIds, arrivalIds)) {
      if (signal?.aborted) {
        return
      }
      try {
        await moveIndexedRows(move.from, move.to, generation)
      } catch (err) {
        // A refused/failed move (e.g. a row appeared at the destination in a
        // race) degrades to today's delete+create: the main pass indexes the
        // arrival, the cleanup loop drops the orphan. Healing is best-effort.
        console.error(`id-based move failed (${move.from} → ${move.to}):`, err)
        continue
      }
      // The moved row carries the old path's hash: the main pass re-indexes
      // at the new path only if the content actually changed in transit.
      const hash = stored.get(move.from)
      stored.delete(move.from)
      if (hash !== undefined) {
        stored.set(move.to, hash)
      }
    }
  }

  for (const file of files) {
    if (signal?.aborted) {
      return
    }
    let content = arrivalContent.get(file.path)
    if (content === undefined) {
      try {
        content = await readNote(file.path)
      } catch (err) {
        // The file moved/was deleted/locked between listFiles() and here (TOCTOU).
        // If it's gone, drop it from `onDisk` so the cleanup loop removes its
        // now-ghost row this pass; for a transient error keep the row and retry.
        if (isAppError(err) && err.kind === 'notFound') {
          onDisk.delete(file.path)
        }
        continue
      }
    }
    const fileHash = await hashContent(content)
    if (stored.get(file.path) === fileHash) {
      continue // unchanged
    }
    if (signal?.aborted) {
      return // re-check after the awaits — don't write for a superseded pass
    }
    const parsed = parseNote({ path: file.path, source: content })
    await applyIndexedNote(
      buildIndexedNote(parsed, { fileHash, mtime: file.modifiedMs, source: content }),
      generation,
    )
  }

  for (const path of stored.keys()) {
    if (signal?.aborted) {
      return
    }
    if (!onDisk.has(path)) {
      await removeFromIndex(path, generation)
    }
  }
}
