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
