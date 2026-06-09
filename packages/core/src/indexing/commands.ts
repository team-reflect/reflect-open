import { z } from 'zod'
import { call } from '../ipc/invoke'
import type { IndexedNote } from './indexed-note'

/** Index commands return `()` from Rust, which serializes to `null` over IPC. */
const voidSchema = z.null()

/** Open + migrate the index for the active graph (Rust reads the root from state). */
export async function openIndex(): Promise<void> {
  await call('index_open', {}, voidSchema)
}

/** Apply one note's projection in a single Rust transaction. */
export async function applyIndexedNote(note: IndexedNote): Promise<void> {
  await call('index_apply', { note }, voidSchema)
}

/** Remove a note (deleted on disk) from the index. */
export async function removeFromIndex(path: string): Promise<void> {
  await call('index_remove', { path }, voidSchema)
}

/** Wipe all derived tables (precedes a full rebuild). */
export async function clearIndex(): Promise<void> {
  await call('index_clear', {}, voidSchema)
}
