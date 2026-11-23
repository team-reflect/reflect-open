import { isIsoDate, type MaybePromise } from '@reflect/utils'
import { noteBasenameKey } from '../graph/note-reference.ts'
import { dateFromDailyPath, foldGraphPath } from '../graph/paths.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { DatabaseService } from './database-service.ts'

import type {
  IndexCommit,
  IndexCommitted,
  IndexTouch,
  ReconcileScan,
  ScanCandidate,
  ScanOrphan,
} from '@reflect/types'
import type { IndexedNote } from './indexed-note.ts'

export type { IndexCommit, IndexCommitted, IndexTouch, ReconcileScan, ScanCandidate, ScanOrphan }

/**
 * Notes per `index_apply_batch` transaction, and re-stamps per `index_touch`
 * transaction, of the index writer. Bounds the IPC payload and transaction
 * size on large graphs while keeping the transaction/round-trip count far
 * below one-per-note.
 */
export const INDEX_APPLY_BATCH_SIZE = 256

/**
 * One note omitted from an index pass because its projection could not be written.
 */
export interface SkippedIndexedNote {
  /**
   * Graph-relative markdown path.
   */
  path: string
  /**
   * Displayable reason from the failed write.
   */
  message: string
}

/**
 * The SQLite projection of the active graph, written through the native
 * `index_*` commands. Every write carries the index `generation` returned by
 * {@link open}; Rust no-ops a write whose generation is stale, so a pass
 * started for one graph can never mutate a newly-opened index.
 */
export interface IndexStoreService {
  /**
   * Open and migrate the index for the active graph; resolves with the new index generation.
   */
  open(): MaybePromise<number>
  /**
   * Apply many notes' projections in one Rust transaction. Every index write
   * resolves with its commit `seq`, `null` when `generation` is stale. An
   * empty batch never reaches the backend and resolves with a `null` seq.
   */
  applyBatch(notes: IndexedNote[], generation: number): Promise<IndexCommit>
  /**
   * Remove a note (deleted on disk) from the index.
   */
  remove(path: string, generation: number): Promise<IndexCommit>
  /**
   * Move a note's index rows only: the file already lives at `to` (an external
   * rename observed after the fact). Embeddings ride along.
   */
  move(from: string, to: string, generation: number): Promise<IndexCommit>
  /**
   * Move a note file and its index rows in one Rust transaction. Pinned
   * state, conflict flags, and embedding vectors survive the rename. Unlike
   * the other writes, `fileGeneration` is the graph generation (the
   * `note_write` gate).
   */
  moveIndexed(from: string, to: string, fileGeneration: number): Promise<void>
  /**
   * Compute the open-path reconcile delta natively: the files that need a
   * read (with their stored facts) and the rows whose files vanished. A stale
   * `generation` reports an empty scan.
   */
  reconcileScan(generation: number): MaybePromise<ReconcileScan>
  /**
   * Re-stamp stored mtimes for notes whose content already matches disk. One
   * Rust transaction per call; an empty batch never reaches the backend and
   * resolves with a `null` seq.
   */
  touch(entries: readonly IndexTouch[], generation: number): MaybePromise<IndexCommit>
  /**
   * Wipe all derived tables (precedes a full rebuild); `chat_*`, `note_visits`, and `index_meta` stay.
   */
  clear(generation: number): Promise<IndexCommit>
  /**
   * Broadcast `index:committed` to every window; a stale generation broadcasts nothing.
   */
  announce(commit: IndexCommitted, generation: number): Promise<void>
  /**
   * One `index_meta` value, or `null` when the key has never been written.
   */
  getMeta(key: string): Promise<string | null>
  /**
   * Upsert one `index_meta` key; a stale generation drops the write.
   */
  setMeta(key: string, value: string, generation: number): Promise<void>
}

/**
 * The path-derived addressing a row move must re-state: the folded destination
 * path plus the tier-1/tier-4 claims that derive from it. Folded here because
 * Rust never folds; mirrors `projectNoteClaims`'s path-derived tiers.
 */
function movedNoteAddress(path: string) {
  const date = dateFromDailyPath(path)
  return {
    pathKey: foldGraphPath(path),
    basenameKey: noteBasenameKey(path),
    dailyDate: date !== null && isIsoDate(date) ? date : null,
  }
}

export interface IndexStoreServiceDeps {
  readonly ipc: IpcBridgeService
  readonly database: DatabaseService
}

class IndexStoreServiceImpl implements IndexStoreService {
  readonly #deps: IndexStoreServiceDeps

  constructor(deps: IndexStoreServiceDeps) {
    this.#deps = deps
  }

  open(): Promise<number> {
    return this.#deps.ipc.call('index_open', {})
  }

  async applyBatch(notes: IndexedNote[], generation: number): Promise<IndexCommit> {
    if (notes.length === 0) {
      return { seq: null }
    }
    return await this.#deps.ipc.call('index_apply_batch', { notes, generation })
  }

  async remove(path: string, generation: number): Promise<IndexCommit> {
    return await this.#deps.ipc.call('index_remove', { path, generation })
  }

  async move(from: string, to: string, generation: number): Promise<IndexCommit> {
    return await this.#deps.ipc.call('index_move', {
      from,
      to,
      generation,
      toAddress: movedNoteAddress(to),
    })
  }

  async moveIndexed(from: string, to: string, fileGeneration: number): Promise<void> {
    await this.#deps.ipc.call('note_move_indexed', {
      request: {
        from,
        to,
        toAddress: movedNoteAddress(to),
        fromAddress: movedNoteAddress(from),
      },
      generation: fileGeneration,
    })
  }

  reconcileScan(generation: number): Promise<ReconcileScan> {
    return this.#deps.ipc.call('index_reconcile_scan', { generation })
  }

  async touch(entries: readonly IndexTouch[], generation: number): Promise<IndexCommit> {
    if (entries.length === 0) {
      return { seq: null }
    }
    return await this.#deps.ipc.call('index_touch', { entries, generation })
  }

  async clear(generation: number): Promise<IndexCommit> {
    return await this.#deps.ipc.call('index_clear', { generation })
  }

  async announce(commit: IndexCommitted, generation: number): Promise<void> {
    await this.#deps.ipc.call('index_announce', { ...commit, generation })
  }

  async getMeta(key: string): Promise<string | null> {
    return await this.#deps.database.read('index_meta_get', { key })
  }

  async setMeta(key: string, value: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('index_meta_set', { key, value, generation })
  }
}

/**
 * An {@link IndexStoreService} over the `index_*` commands, reading `index_meta` through `database`.
 */
export function createIndexStoreService(deps: IndexStoreServiceDeps): IndexStoreService {
  return new IndexStoreServiceImpl(deps)
}
