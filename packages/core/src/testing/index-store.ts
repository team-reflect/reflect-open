import { isIsoDate } from '@reflect/utils'
import { noteBasenameKey } from '../graph/note-reference.ts'
import { dateFromDailyPath, foldGraphPath } from '../graph/paths.ts'
import type { IndexedNote } from '../indexing/indexed-note.ts'
import {
  createIndexApplyBatchWriter,
  createMtimeTouchBatchWriter,
  type IndexApplyBatch,
  type IndexTouch,
  type IndexStoreService,
  type MtimeTouchBatch,
  type SkippedIndexedNote,
  type ReconcileScan,
} from '../indexing/index-store-service.ts'
import type { TestDatabaseService } from './database.ts'

/**
 * One recorded {@link IndexStoreService} call.
 */
export type IndexStoreCall =
  | { readonly method: 'open' }
  | { readonly method: 'apply'; readonly note: IndexedNote; readonly generation: number }
  | {
      readonly method: 'applyBatch'
      readonly notes: readonly IndexedNote[]
      readonly generation: number
    }
  | { readonly method: 'remove'; readonly path: string; readonly generation: number }
  | {
      readonly method: 'move'
      readonly from: string
      readonly to: string
      readonly generation: number
    }
  | {
      readonly method: 'moveIndexed'
      readonly from: string
      readonly to: string
      readonly fileGeneration: number
    }
  | { readonly method: 'reconcileScan'; readonly generation: number }
  | {
      readonly method: 'touch'
      readonly entries: readonly IndexTouch[]
      readonly generation: number
    }
  | { readonly method: 'clear'; readonly generation: number }
  | { readonly method: 'getMeta'; readonly key: string }
  | {
      readonly method: 'setMeta'
      readonly key: string
      readonly value: string
      readonly generation: number
    }

export interface TestIndexStoreServiceOptions {
  /**
   * Mirror applies, removes, moves, clears and `index_meta` into this
   * database, so reads through it see what the store wrote.
   */
  database?: TestDatabaseService
  /**
   * What `open` resolves with. Defaults to `1`.
   */
  generation?: number
  /**
   * What `reconcileScan` resolves with. Defaults to an empty scan.
   */
  scan?: ReconcileScan
  /**
   * Initial `index_meta` entries.
   */
  meta?: Readonly<Record<string, string>>
  /**
   * Called after a call is recorded and before it takes effect. A returned
   * `Error` rejects the call with it.
   */
  fail?: (call: IndexStoreCall) => Error | undefined
}

export interface TestIndexStoreService extends IndexStoreService {
  /**
   * Every call, in order, including calls that `fail` rejected.
   */
  calls(): readonly IndexStoreCall[]
  /**
   * Every projection written by `apply` and `applyBatch`, in order.
   */
  applied(): readonly IndexedNote[]
  /**
   * Every path passed to a successful `remove`, in order.
   */
  removed(): readonly string[]
  /**
   * Every successful `move` and `moveIndexed`, in order.
   */
  moved(): readonly { readonly from: string; readonly to: string }[]
}

const EMPTY_SCAN: ReconcileScan = { total: 0, candidates: [], orphans: [], stalePlaceholders: [] }

class TestIndexStoreServiceImpl implements TestIndexStoreService {
  readonly #database: TestDatabaseService | undefined
  readonly #generation: number
  readonly #scan: ReconcileScan
  readonly #fail: ((call: IndexStoreCall) => Error | undefined) | undefined
  readonly #meta: Map<string, string>
  readonly #log: IndexStoreCall[] = []
  readonly #appliedNotes: IndexedNote[] = []
  readonly #removedPaths: string[] = []
  readonly #moves: { from: string; to: string }[] = []
  #metaSeeded: boolean

  constructor(options: TestIndexStoreServiceOptions | undefined) {
    this.#database = options?.database
    this.#generation = options?.generation ?? 1
    this.#scan = options?.scan ?? EMPTY_SCAN
    this.#fail = options?.fail
    this.#meta = new Map(Object.entries(options?.meta ?? {}))
    this.#metaSeeded = this.#database === undefined
  }

  open(): Promise<number> {
    return Promise.try(() => {
      this.#record({ method: 'open' })
      return this.#generation
    })
  }

  apply(note: IndexedNote, writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'apply', note, generation: writeGeneration })
      this.#writeNotes([note])
    })
  }

  applyBatch(notes: IndexedNote[], writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'applyBatch', notes: [...notes], generation: writeGeneration })
      this.#writeNotes(notes)
    })
  }

  remove(path: string, writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'remove', path, generation: writeGeneration })
      this.#database?.invoke('index_remove', { path, generation: this.#database.generation() })
      this.#removedPaths.push(path)
    })
  }

  move(from: string, to: string, writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'move', from, to, generation: writeGeneration })
      this.#moveRows(from, to)
      this.#moves.push({ from, to })
    })
  }

  moveIndexed(from: string, to: string, fileGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'moveIndexed', from, to, fileGeneration })
      this.#moveRows(from, to)
      this.#moves.push({ from, to })
    })
  }

  reconcileScan(scanGeneration: number): Promise<ReconcileScan> {
    return Promise.try(() => {
      this.#record({ method: 'reconcileScan', generation: scanGeneration })
      return this.#scan
    })
  }

  touch(entries: readonly IndexTouch[], writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'touch', entries: [...entries], generation: writeGeneration })
    })
  }

  clear(writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'clear', generation: writeGeneration })
      this.#database?.invoke('index_clear', { generation: this.#database.generation() })
    })
  }

  async getMeta(key: string): Promise<string | null> {
    this.#record({ method: 'getMeta', key })
    const database = this.#database
    if (database === undefined) {
      return this.#meta.get(key) ?? null
    }
    this.#seedMeta()
    const row = await database.db
      .selectFrom('indexMeta')
      .where('key', '=', key)
      .select('value')
      .executeTakeFirst()
    return row?.value ?? null
  }

  setMeta(key: string, value: string, writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'setMeta', key, value, generation: writeGeneration })
      this.#seedMeta()
      this.#writeMeta(key, value)
    })
  }

  createApplyBatch(
    writeGeneration: number,
    onSkippedNote?: (note: SkippedIndexedNote) => void,
  ): IndexApplyBatch {
    return createIndexApplyBatchWriter(
      (notes, generation) => this.applyBatch(notes, generation),
      writeGeneration,
      onSkippedNote,
    )
  }

  createTouchBatch(writeGeneration: number): MtimeTouchBatch {
    return createMtimeTouchBatchWriter(
      (entries, generation) => this.touch(entries, generation),
      writeGeneration,
    )
  }

  calls(): readonly IndexStoreCall[] {
    return [...this.#log]
  }

  applied(): readonly IndexedNote[] {
    return [...this.#appliedNotes]
  }

  removed(): readonly string[] {
    return [...this.#removedPaths]
  }

  moved(): readonly { readonly from: string; readonly to: string }[] {
    return this.#moves.map((move) => ({ ...move }))
  }

  #record(call: IndexStoreCall): void {
    this.#log.push(call)
    const failure = this.#fail?.(call)
    if (failure !== undefined) {
      throw failure
    }
  }

  #seedMeta(): void {
    if (this.#metaSeeded || this.#database === undefined) {
      return
    }
    this.#metaSeeded = true
    for (const [key, value] of this.#meta) {
      this.#writeMeta(key, value)
    }
  }

  #writeMeta(key: string, value: string): void {
    if (this.#database === undefined) {
      this.#meta.set(key, value)
      return
    }
    this.#database.invoke('index_meta_set', {
      key,
      value,
      generation: this.#database.generation(),
    })
  }

  #writeNotes(notes: readonly IndexedNote[]): void {
    const database = this.#database
    for (const note of notes) {
      if (database !== undefined) {
        database.applyProjection(note)
      }
      this.#appliedNotes.push(note)
    }
  }

  #moveRows(from: string, to: string): void {
    const database = this.#database
    if (database === undefined) {
      return
    }
    const date = dateFromDailyPath(to)
    const toAddress = {
      pathKey: foldGraphPath(to),
      basenameKey: noteBasenameKey(to),
      dailyDate: date !== null && isIsoDate(date) ? date : null,
    }
    database.invoke('index_move', { from, to, generation: database.generation(), toAddress })
  }
}

/**
 * An in-memory {@link IndexStoreService} that records every call.
 */
export function createTestIndexStoreService(
  options?: TestIndexStoreServiceOptions,
): TestIndexStoreService {
  return new TestIndexStoreServiceImpl(options)
}
