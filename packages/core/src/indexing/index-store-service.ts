import type { MaybePromise } from '@reflect/utils'
import { z } from 'zod'
import { errorMessage } from '../errors.ts'
import { noteBasenameKey } from '../graph/note-reference.ts'
import { dateFromDailyPath, foldGraphPath, isCalendarDate } from '../graph/paths.ts'
import type { IpcBridgeService } from '../ipc/ipc-service.ts'
import type { DatabaseService } from './database-service.ts'

import type { IndexedNote } from './indexed-note.ts'

/**
 * Index commands return `()` from Rust, which serializes to `null` over IPC.
 */
const voidSchema = z.null()

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

export const reconcileScanSchema = z.object({
  total: z.number(),
  candidates: z.array(scanCandidateSchema),
  orphans: z.array(scanOrphanSchema),
  /**
   * Evicted files whose content the index lacks: no stored row, or a listed
   * mtime differing from the stored row (a remote edit synced while
   * evicted). Never candidates: they can't be read without forcing an
   * on-demand download, so the reconcile surfaces them for a targeted
   * `icloud_request_downloads`; the materialized files then arrive as
   * ordinary watcher upserts.
   */
  stalePlaceholders: z.array(z.string()),
})

/**
 * One file the reconcile must read; see {@link IndexStoreService.reconcileScan}.
 */
export type ScanCandidate = z.infer<typeof scanCandidateSchema>

/**
 * A stored row whose file vanished from disk; see {@link IndexStoreService.reconcileScan}.
 */
export type ScanOrphan = z.infer<typeof scanOrphanSchema>

/**
 * The reconcile delta: what changed on disk relative to the index.
 */
export type ReconcileScan = z.infer<typeof reconcileScanSchema>

/**
 * One {@link IndexStoreService.touch} entry: re-stamp `path`'s stored mtime.
 */
export interface IndexedNoteTouch {
  /**
   * Graph-relative markdown path.
   */
  readonly path: string
  /**
   * The file's listed on-disk mtime (epoch ms).
   */
  readonly mtime: number
}

/**
 * Notes per `index_apply_batch` transaction in the bulk passes (rebuild,
 * reconcile, and large watcher batches). Bounds the IPC payload and
 * transaction size on large graphs while keeping the transaction/round-trip
 * count far below one-per-note.
 */
export const INDEX_APPLY_BATCH_SIZE = 256

/**
 * One note omitted from a bulk write because its projection could not be written.
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
 * A shared accumulator for bulk index writes; see {@link IndexStoreService.createApplyBatch}.
 */
export interface IndexApplyBatch {
  /**
   * Queue a projection; flushes automatically at the transaction cap.
   */
  add: (note: IndexedNote) => Promise<void>
  /**
   * Apply everything still queued. Safe to call repeatedly.
   */
  flush: () => Promise<void>
  /**
   * Projections actually written so far (skipped notes excluded).
   */
  applied: () => number
}

/**
 * A shared accumulator for mtime re-stamps; see {@link IndexStoreService.createTouchBatch}.
 */
export interface MtimeTouchBatch {
  /**
   * Queue a re-stamp; flushes automatically at the transaction cap.
   */
  add: (entry: IndexedNoteTouch) => Promise<void>
  /**
   * Apply everything still queued. Safe to call repeatedly.
   */
  flush: () => Promise<void>
  /**
   * Re-stamps actually written so far.
   */
  applied: () => number
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
   * Apply one note's projection in a single Rust transaction.
   */
  apply(note: IndexedNote, generation: number): Promise<void>
  /**
   * Apply many notes' projections in one Rust transaction. An empty batch never reaches the backend.
   */
  applyBatch(notes: IndexedNote[], generation: number): Promise<void>
  /**
   * Remove a note (deleted on disk) from the index.
   */
  remove(path: string, generation: number): Promise<void>
  /**
   * Move a note's index rows only: the file already lives at `to` (an external
   * rename observed after the fact). Embeddings ride along.
   */
  move(from: string, to: string, generation: number): Promise<void>
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
   * Rust transaction per call; an empty batch never reaches the backend.
   */
  touch(entries: readonly IndexedNoteTouch[], generation: number): MaybePromise<void>
  /**
   * Wipe all derived tables (precedes a full rebuild); `chat_*` and `index_meta` stay.
   */
  clear(generation: number): Promise<void>
  /**
   * One `index_meta` value, or `null` when the key has never been written.
   */
  getMeta(key: string): Promise<string | null>
  /**
   * Upsert one `index_meta` key; a stale generation drops the write.
   */
  setMeta(key: string, value: string, generation: number): Promise<void>
  /**
   * Accumulate projections and apply them in shared `index_apply_batch`
   * transactions of {@link INDEX_APPLY_BATCH_SIZE}. A refused batch splits in
   * half until the failing note stands alone; that note reports through
   * `onSkippedNote`, or its error is thrown without one.
   */
  createApplyBatch(
    generation: number,
    onSkippedNote?: (note: SkippedIndexedNote) => void,
  ): IndexApplyBatch
  /**
   * Accumulate mtime re-stamps and apply them in shared `index_touch` transactions.
   */
  createTouchBatch(generation: number): MtimeTouchBatch
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
    dailyDate: date !== null && isCalendarDate(date) ? date : null,
  }
}

async function applySplitBatch(
  applyBatch: IndexStoreService['applyBatch'],
  notes: IndexedNote[],
  generation: number,
  onSkippedNote: ((note: SkippedIndexedNote) => void) | undefined,
): Promise<number> {
  if (notes.length === 0) {
    return 0
  }
  try {
    await applyBatch(notes, generation)
    return notes.length
  } catch (cause) {
    if (notes.length === 1) {
      if (onSkippedNote === undefined) {
        throw cause
      }
      onSkippedNote({ path: notes[0]!.path, message: errorMessage(cause) })
      return 0
    }
    const midpoint = Math.ceil(notes.length / 2)
    const first = await applySplitBatch(
      applyBatch,
      notes.slice(0, midpoint),
      generation,
      onSkippedNote,
    )
    return (
      first + (await applySplitBatch(applyBatch, notes.slice(midpoint), generation, onSkippedNote))
    )
  }
}

class BatchWriter<Item> {
  readonly #write: (items: Item[]) => Promise<number>
  #batch: Item[] = []
  #appliedCount = 0

  constructor(write: (items: Item[]) => Promise<number>) {
    this.#write = write
  }

  async add(item: Item): Promise<void> {
    this.#batch.push(item)
    if (this.#batch.length >= INDEX_APPLY_BATCH_SIZE) {
      await this.flush()
    }
  }

  async flush(): Promise<void> {
    if (this.#batch.length === 0) {
      return
    }
    const items = this.#batch
    this.#batch = []
    this.#appliedCount += await this.#write(items)
  }

  applied(): number {
    return this.#appliedCount
  }
}

/**
 * {@link IndexStoreService.createApplyBatch} over any `applyBatch`.
 */
export function createIndexApplyBatchWriter(
  applyBatch: IndexStoreService['applyBatch'],
  generation: number,
  onSkippedNote?: (note: SkippedIndexedNote) => void,
): IndexApplyBatch {
  return new BatchWriter((notes: IndexedNote[]) => {
    return applySplitBatch(applyBatch, notes, generation, onSkippedNote)
  })
}

/**
 * {@link IndexStoreService.createTouchBatch} over any `touch`.
 */
export function createMtimeTouchBatchWriter(
  touch: IndexStoreService['touch'],
  generation: number,
): MtimeTouchBatch {
  return new BatchWriter(async (entries: IndexedNoteTouch[]) => {
    await touch(entries, generation)
    return entries.length
  })
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
    return this.#deps.ipc.call('index_open', {}, z.number())
  }

  async apply(note: IndexedNote, generation: number): Promise<void> {
    await this.#deps.ipc.call('index_apply', { note, generation }, voidSchema)
  }

  async applyBatch(notes: IndexedNote[], generation: number): Promise<void> {
    if (notes.length === 0) {
      return
    }
    await this.#deps.ipc.call('index_apply_batch', { notes, generation }, voidSchema)
  }

  async remove(path: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('index_remove', { path, generation }, voidSchema)
  }

  async move(from: string, to: string, generation: number): Promise<void> {
    await this.#deps.ipc.call(
      'index_move',
      { from, to, generation, toAddress: movedNoteAddress(to) },
      voidSchema,
    )
  }

  async moveIndexed(from: string, to: string, fileGeneration: number): Promise<void> {
    await this.#deps.ipc.call(
      'note_move_indexed',
      {
        request: {
          from,
          to,
          toAddress: movedNoteAddress(to),
          fromAddress: movedNoteAddress(from),
        },
        generation: fileGeneration,
      },
      voidSchema,
    )
  }

  reconcileScan(generation: number): Promise<ReconcileScan> {
    return this.#deps.ipc.call('index_reconcile_scan', { generation }, reconcileScanSchema)
  }

  async touch(entries: readonly IndexedNoteTouch[], generation: number): Promise<void> {
    if (entries.length === 0) {
      return
    }
    await this.#deps.ipc.call('index_touch', { entries, generation }, voidSchema)
  }

  async clear(generation: number): Promise<void> {
    await this.#deps.ipc.call('index_clear', { generation }, voidSchema)
  }

  async getMeta(key: string): Promise<string | null> {
    const row = await this.#deps.database.db
      .selectFrom('indexMeta')
      .where('key', '=', key)
      .select('value')
      .executeTakeFirst()
    return row?.value ?? null
  }

  async setMeta(key: string, value: string, generation: number): Promise<void> {
    await this.#deps.ipc.call('index_meta_set', { key, value, generation }, voidSchema)
  }

  createApplyBatch(
    generation: number,
    onSkippedNote?: (note: SkippedIndexedNote) => void,
  ): IndexApplyBatch {
    return createIndexApplyBatchWriter(
      (notes, gen) => this.applyBatch(notes, gen),
      generation,
      onSkippedNote,
    )
  }

  createTouchBatch(generation: number): MtimeTouchBatch {
    return createMtimeTouchBatchWriter((entries, gen) => this.touch(entries, gen), generation)
  }
}

/**
 * An {@link IndexStoreService} over the `index_*` commands, reading `index_meta` through `database`.
 */
export function createIndexStoreService(deps: IndexStoreServiceDeps): IndexStoreService {
  return new IndexStoreServiceImpl(deps)
}
