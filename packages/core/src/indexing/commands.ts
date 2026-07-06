import { z } from 'zod'
import { call } from '../ipc/invoke'
import type { IndexedNote } from './indexed-note'

/** Index commands return `()` from Rust, which serializes to `null` over IPC. */
const voidSchema = z.null()

/**
 * Open + migrate the index for the active graph (Rust reads the root from state)
 * and return the new index **generation**. Write commands echo this back; Rust
 * no-ops a write whose generation is stale, so a pass started for one graph can
 * never mutate a newly-opened index.
 */
export async function openIndex(): Promise<number> {
  return call('index_open', {}, z.number())
}

/** Apply one note's projection in a single Rust transaction (for `generation`). */
export async function applyIndexedNote(note: IndexedNote, generation: number): Promise<void> {
  await call('index_apply', { note, generation }, voidSchema)
}

/**
 * Apply many notes' projections in one Rust transaction (for `generation`). Used
 * by the full rebuild, where a transaction (and prepared-statement reuse) per
 * note would be needless overhead. A no-op for an empty batch — it never touches
 * the backend.
 */
export async function applyIndexedNotes(notes: IndexedNote[], generation: number): Promise<void> {
  if (notes.length === 0) {
    return
  }
  await call('index_apply_batch', { notes, generation }, voidSchema)
}

/** Remove a note (deleted on disk) from the index (for `generation`). */
export async function removeFromIndex(path: string, generation: number): Promise<void> {
  await call('index_remove', { path, generation }, voidSchema)
}

/**
 * Move a note's index rows **only** — the id-based reconcile half of Plan 17:
 * the file already lives at `to` (an external rename observed after the fact,
 * paired to its old row by frontmatter id). Embeddings ride along, so a
 * healed rename never re-embeds. Gated on the **index** generation like every
 * other reconcile-path write.
 */
export async function moveIndexedRows(
  from: string,
  to: string,
  generation: number,
): Promise<void> {
  await call('index_move', { from, to, generation }, voidSchema)
}

/**
 * Move a note file **and** its index rows in one Rust transaction (Plan 17):
 * pinned state, conflict flags, and embedding vectors survive the rename, and
 * the watcher's delete+create echo is benign by construction (the remove
 * finds no rows; the upsert re-applies identical rows). Unlike
 * the other index commands, `generation` here is the **graph** generation
 * (the `note_write` gate) — a rename is user-initiated file mutation.
 */
export async function moveNoteIndexed(
  from: string,
  to: string,
  generation: number,
): Promise<void> {
  await call('note_move_indexed', { from, to, generation }, voidSchema)
}

const scanCandidateSchema = z.object({
  path: z.string(),
  modifiedMs: z.number(),
  storedMtime: z.number().nullable(),
  storedHash: z.string().nullable(),
})

const scanOrphanSchema = z.object({
  path: z.string(),
  storedMtime: z.number(),
  storedHash: z.string(),
})

const reconcileScanSchema = z.object({
  total: z.number(),
  candidates: z.array(scanCandidateSchema),
  orphans: z.array(scanOrphanSchema),
})

/** One file the reconcile must read — see {@link reconcileScan}. */
export type ScanCandidate = z.infer<typeof scanCandidateSchema>

/** A stored row whose file vanished from disk — see {@link reconcileScan}. */
export type ScanOrphan = z.infer<typeof scanOrphanSchema>

/** The reconcile delta: what changed on disk relative to the index. */
export type ReconcileScan = z.infer<typeof reconcileScanSchema>

/**
 * Compute the open-path reconcile delta natively: Rust lists the graph's
 * notes and compares mtimes against the stored rows, returning only the
 * files that need a read (with their stored facts riding along) and the
 * rows whose files vanished. One IPC round-trip replaces the full-listing
 * `listFiles` + stored-facts sweep the webview used to crawl on every open —
 * on a healthy graph the delta is empty and the pass costs nothing. A stale
 * `generation` reports an empty scan.
 */
export async function reconcileScan(generation: number): Promise<ReconcileScan> {
  return call('index_reconcile_scan', { generation }, reconcileScanSchema)
}

/** One {@link touchIndexedNotes} entry: re-stamp `path`'s stored mtime. */
export interface IndexedNoteTouch {
  /** Graph-relative markdown path. */
  readonly path: string
  /** The file's listed on-disk mtime (epoch ms). */
  readonly mtime: number
}

/**
 * Re-stamp stored mtimes for notes whose content already matches disk (for
 * `generation`). The reconcile's self-heal: a row written from a local write
 * echo carries an echo-time stamp that never equals the listed mtime, and a
 * hash-match skip leaves it in place — without this repair the file is
 * re-read and re-hashed on every future pass. One Rust transaction per call;
 * an empty batch never touches the backend.
 */
export async function touchIndexedNotes(
  entries: readonly IndexedNoteTouch[],
  generation: number,
): Promise<void> {
  if (entries.length === 0) {
    return
  }
  await call('index_touch', { entries, generation }, voidSchema)
}

/** Wipe all derived tables (precedes a full rebuild; for `generation`). */
export async function clearIndex(generation: number): Promise<void> {
  await call('index_clear', { generation }, voidSchema)
}

/**
 * Upsert one `index_meta` key (for `generation`; a stale stamp is dropped).
 * Bookkeeping the TS policy layer owns — e.g. the projection-version stamp a
 * rebuild leaves behind. Reads go through the ordinary Kysely `db_query` path.
 */
export async function setIndexMeta(
  key: string,
  value: string,
  generation: number,
): Promise<void> {
  await call('index_meta_set', { key, value, generation }, voidSchema)
}

/** Start (or restart) the filesystem watcher for the active graph (Plan 04b). */
export async function watchStart(): Promise<void> {
  await call('watch_start', {}, voidSchema)
}

/** Stop the filesystem watcher. */
export async function watchStop(): Promise<void> {
  await call('watch_stop', {}, voidSchema)
}
