import { INDEX_COMMITTED_EVENT } from '../ipc/ipc-service.ts'
import type { TestIpcBridgeService } from './ipc.ts'
import { isIsoDate, type MaybePromise } from '@reflect/utils'
import { noteBasenameKey } from '../graph/note-reference.ts'
import { dateFromDailyPath, foldGraphPath } from '../graph/paths.ts'
import type { IndexedNote } from '../indexing/indexed-note.ts'
import type {
  IndexCommit,
  IndexCommitted,
  IndexTouch,
  IndexStoreService,
  ReconcileScan,
} from '../indexing/index-store-service.ts'
import type { TestDatabaseService } from './database.ts'

/**
 * One recorded {@link IndexStoreService} call.
 */
export type IndexStoreCall =
  | { readonly method: 'open' }
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
   * Mirror applies, removes, moves, touches, clears and `index_meta` into
   * this database, so reads through it see what the store wrote.
   */
  database?: TestDatabaseService
  /**
   * What `open` resolves with. Defaults to `1`.
   */
  generation?: number
  /**
   * What `reconcileScan` resolves with: a fixed scan, or a function called
   * once per scan. Defaults to an empty scan.
   */
  scan?: ReconcileScan | (() => MaybePromise<ReconcileScan>)
  /**
   * Initial `index_meta` entries.
   */
  meta?: Readonly<Record<string, string>>
  /**
   * Where `announce` emits `index:committed`, as the native index does to every window.
   */
  ipc?: TestIpcBridgeService
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
   * Every projection written by `applyBatch`, in order.
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
  /**
   * Every commit passed to `announce`, in order. `calls` leaves them out.
   */
  announced(): readonly IndexCommitted[]
}

const EMPTY_SCAN: ReconcileScan = { total: 0, candidates: [], orphans: [], stalePlaceholders: [] }

class TestIndexStoreServiceImpl implements TestIndexStoreService {
  readonly #database: TestDatabaseService | undefined
  readonly #generation: number
  readonly #ipc: TestIpcBridgeService | undefined
  readonly #scan: ReconcileScan | (() => MaybePromise<ReconcileScan>)
  readonly #fail: ((call: IndexStoreCall) => Error | undefined) | undefined
  readonly #meta: Map<string, string>
  readonly #log: IndexStoreCall[] = []
  readonly #appliedNotes: IndexedNote[] = []
  readonly #removedPaths: string[] = []
  readonly #moves: { from: string; to: string }[] = []
  readonly #announcements: IndexCommitted[] = []
  #metaSeeded: boolean
  #seq = 0

  constructor(options: TestIndexStoreServiceOptions | undefined) {
    this.#database = options?.database
    this.#generation = options?.generation ?? 1
    this.#ipc = options?.ipc
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

  applyBatch(notes: IndexedNote[], writeGeneration: number): Promise<IndexCommit> {
    return Promise.try(() => {
      this.#record({ method: 'applyBatch', notes: [...notes], generation: writeGeneration })
      return this.#writeNotes(notes)
    })
  }

  remove(path: string, writeGeneration: number): Promise<IndexCommit> {
    return Promise.try(() => {
      this.#record({ method: 'remove', path, generation: writeGeneration })
      const commit = this.#database?.invoke('index_remove', {
        path,
        generation: this.#database.generation(),
      })
      this.#removedPaths.push(path)
      return commit ?? this.#commit()
    })
  }

  move(from: string, to: string, writeGeneration: number): Promise<IndexCommit> {
    return Promise.try(() => {
      this.#record({ method: 'move', from, to, generation: writeGeneration })
      const commit = this.#moveRows(from, to)
      this.#moves.push({ from, to })
      return commit
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
      return typeof this.#scan === 'function' ? this.#scan() : this.#scan
    })
  }

  touch(entries: readonly IndexTouch[], writeGeneration: number): Promise<IndexCommit> {
    return Promise.try(() => {
      this.#record({ method: 'touch', entries: [...entries], generation: writeGeneration })
      const commit = this.#database?.invoke('index_touch', {
        entries: [...entries],
        generation: this.#database.generation(),
      })
      return commit ?? this.#commit()
    })
  }

  clear(writeGeneration: number): Promise<IndexCommit> {
    return Promise.try(() => {
      this.#record({ method: 'clear', generation: writeGeneration })
      const commit = this.#database?.invoke('index_clear', {
        generation: this.#database.generation(),
      })
      return commit ?? this.#commit()
    })
  }

  announce(commit: IndexCommitted): Promise<void> {
    this.#announcements.push(commit)
    this.#ipc?.emit(INDEX_COMMITTED_EVENT, commit)
    return Promise.resolve()
  }

  async getMeta(key: string): Promise<string | null> {
    this.#record({ method: 'getMeta', key })
    const database = this.#database
    if (database === undefined) {
      return this.#meta.get(key) ?? null
    }
    this.#seedMeta()
    return await database.read('index_meta_get', { key })
  }

  setMeta(key: string, value: string, writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'setMeta', key, value, generation: writeGeneration })
      this.#seedMeta()
      this.#writeMeta(key, value)
    })
  }

  calls(): readonly IndexStoreCall[] {
    return [...this.#log]
  }

  announced(): readonly IndexCommitted[] {
    return [...this.#announcements]
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

  /**
   * The next commit of a store without a database.
   */
  #commit(): IndexCommit {
    this.#seq += 1
    return { seq: this.#seq }
  }

  #writeNotes(notes: readonly IndexedNote[]): IndexCommit {
    const database = this.#database
    this.#appliedNotes.push(...notes)
    if (notes.length === 0) {
      return { seq: null }
    }
    if (database === undefined) {
      return this.#commit()
    }
    return database.invoke('index_apply_batch', {
      notes: [...notes],
      generation: database.generation(),
    })
  }

  #moveRows(from: string, to: string): IndexCommit {
    const database = this.#database
    if (database === undefined) {
      return this.#commit()
    }
    const date = dateFromDailyPath(to)
    const toAddress = {
      pathKey: foldGraphPath(to),
      basenameKey: noteBasenameKey(to),
      dailyDate: date !== null && isIsoDate(date) ? date : null,
    }
    return database.invoke('index_move', {
      from,
      to,
      generation: database.generation(),
      toAddress,
    })
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
