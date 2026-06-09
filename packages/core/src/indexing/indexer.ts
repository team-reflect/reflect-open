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

/** Full rebuild: wipe derived tables and re-index every markdown file. */
export async function rebuildIndex(options?: IndexPassOptions): Promise<void> {
  await clearIndex()
  const files = await listFiles()
  for (const file of files) {
    if (options?.signal?.aborted) {
      return
    }
    await indexNote(file.path, { mtime: file.modifiedMs })
  }
}

/**
 * Reconcile the index with disk (the open path): re-index files whose content
 * hash changed, and drop rows for files that no longer exist. Cheaper than a full
 * rebuild on an already-populated index, and abortable on graph switch.
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
    const content = await readNote(file.path)
    const fileHash = await hashContent(content)
    if (stored.get(file.path) === fileHash) {
      continue // unchanged
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
