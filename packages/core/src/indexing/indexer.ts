import { listFiles, readNote } from '../graph/commands'
import { parseNote } from '../markdown'
import { applyIndexedNote, clearIndex, removeFromIndex } from './commands'
import { hashContent } from './hash'
import { buildIndexedNote } from './indexed-note'
import { getIndexedHashes } from './queries'

/**
 * The indexing pipeline (Plan 04): read (Plan 02) → parse/extract in TS
 * (Plan 03) → hash → hand the flattened projection to Rust, which applies it in
 * one transaction. The index is a rebuildable cache.
 */

/** Read, parse, and (re)index a single note. */
export async function indexNote(
  path: string,
  options?: { content?: string; mtime?: number },
): Promise<void> {
  const content = options?.content ?? (await readNote(path))
  const parsed = parseNote({ path, source: content })
  const fileHash = await hashContent(content)
  await applyIndexedNote(buildIndexedNote(parsed, { fileHash, mtime: options?.mtime ?? 0 }))
}

/**
 * Options for the long-running index passes. `signal` lets the caller abort
 * between files when the active graph changes — without it, a stale pass would
 * keep writing to whatever index/graph is now open and corrupt the cache.
 */
export interface IndexPassOptions {
  signal?: AbortSignal
}

/**
 * Full rebuild: wipe derived tables and re-index every markdown file. Used for
 * explicit repair / schema-bump triggers, not the hot graph-switch path (that's
 * {@link reconcileIndex}). Abort is checked **only before** the wipe — once we've
 * cleared, we run to completion so an interrupted rebuild can't leave the index
 * empty or half-populated.
 */
export async function rebuildIndex(options?: IndexPassOptions): Promise<void> {
  if (options?.signal?.aborted) {
    return // don't wipe the current index for an already-cancelled pass
  }
  await clearIndex()
  const files = await listFiles()
  for (const file of files) {
    await indexNote(file.path, { mtime: file.modifiedMs })
  }
}

/**
 * Reconcile the index with disk (the open path): re-index files whose content
 * hash changed, and drop rows for files that no longer exist. Cheaper than a full
 * rebuild on an already-populated index, and abortable on graph switch.
 *
 * The caller (GraphProvider) aborts the prior reconcile and **awaits its
 * settlement before calling `openIndex` to swap the Rust connection**, so a pass
 * cannot run concurrently with a connection swap. The abort checks here make a
 * superseded pass stop promptly; a generation token bound to the index
 * connection in Rust — making stale writes caller-independent — is planned with
 * the live watcher (Plan 04b), where indexing also runs outside this serialized
 * open flow.
 */
export async function reconcileIndex(options?: IndexPassOptions): Promise<void> {
  const signal = options?.signal
  const files = await listFiles()
  if (signal?.aborted) {
    return
  }
  const onDisk = new Set(files.map((file) => file.path))
  const stored = await getIndexedHashes()

  for (const file of files) {
    if (signal?.aborted) {
      return
    }
    let content: string
    try {
      content = await readNote(file.path)
    } catch {
      // The file moved/was deleted/locked between listFiles() and here (TOCTOU)
      // — skip it rather than aborting the whole pass; a later pass will catch up.
      continue
    }
    const fileHash = await hashContent(content)
    if (stored.get(file.path) === fileHash) {
      continue // unchanged
    }
    if (signal?.aborted) {
      return // re-check after the awaits — don't write for a superseded pass
    }
    const parsed = parseNote({ path: file.path, source: content })
    await applyIndexedNote(buildIndexedNote(parsed, { fileHash, mtime: file.modifiedMs }))
  }

  for (const path of stored.keys()) {
    if (signal?.aborted) {
      return
    }
    if (!onDisk.has(path)) {
      await removeFromIndex(path)
    }
  }
}
