import { isIsoDate } from '@reflect/utils'
import { AppError } from '../errors.ts'
import { noteBasenameKey } from '../graph/note-reference.ts'
import { dateFromDailyPath, foldGraphPath } from '../graph/paths.ts'
import { CLAIM_TIER, type IndexedNote } from '../indexing/indexed-note.ts'
import {
  createIndexApplyBatchWriter,
  createMtimeTouchBatchWriter,
  type IndexApplyBatch,
  type IndexedNoteTouch,
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
      readonly entries: readonly IndexedNoteTouch[]
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

  async apply(note: IndexedNote, writeGeneration: number): Promise<void> {
    this.#record({ method: 'apply', note, generation: writeGeneration })
    await this.#writeNotes([note])
  }

  async applyBatch(notes: IndexedNote[], writeGeneration: number): Promise<void> {
    this.#record({ method: 'applyBatch', notes: [...notes], generation: writeGeneration })
    await this.#writeNotes(notes)
  }

  async remove(path: string, writeGeneration: number): Promise<void> {
    this.#record({ method: 'remove', path, generation: writeGeneration })
    await this.#database?.runQuery('DELETE FROM notes WHERE path = ?', [path])
    this.#removedPaths.push(path)
  }

  async move(from: string, to: string, writeGeneration: number): Promise<void> {
    this.#record({ method: 'move', from, to, generation: writeGeneration })
    await this.#moveRows(from, to)
    this.#moves.push({ from, to })
  }

  async moveIndexed(from: string, to: string, fileGeneration: number): Promise<void> {
    this.#record({ method: 'moveIndexed', from, to, fileGeneration })
    await this.#moveRows(from, to)
    this.#moves.push({ from, to })
  }

  reconcileScan(scanGeneration: number): Promise<ReconcileScan> {
    return Promise.try(() => {
      this.#record({ method: 'reconcileScan', generation: scanGeneration })
      return this.#scan
    })
  }

  touch(entries: readonly IndexedNoteTouch[], writeGeneration: number): Promise<void> {
    return Promise.try(() => {
      this.#record({ method: 'touch', entries: [...entries], generation: writeGeneration })
    })
  }

  async clear(writeGeneration: number): Promise<void> {
    this.#record({ method: 'clear', generation: writeGeneration })
    await this.#database?.runQuery('DELETE FROM notes', [])
  }

  async getMeta(key: string): Promise<string | null> {
    this.#record({ method: 'getMeta', key })
    const database = this.#database
    if (database === undefined) {
      return this.#meta.get(key) ?? null
    }
    await this.#seedMeta()
    const row = await database.db
      .selectFrom('indexMeta')
      .where('key', '=', key)
      .select('value')
      .executeTakeFirst()
    return row?.value ?? null
  }

  async setMeta(key: string, value: string, writeGeneration: number): Promise<void> {
    this.#record({ method: 'setMeta', key, value, generation: writeGeneration })
    await this.#seedMeta()
    await this.#writeMeta(key, value)
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

  async #seedMeta(): Promise<void> {
    if (this.#metaSeeded || this.#database === undefined) {
      return
    }
    this.#metaSeeded = true
    for (const [key, value] of this.#meta) {
      await this.#writeMeta(key, value)
    }
  }

  async #writeMeta(key: string, value: string): Promise<void> {
    if (this.#database === undefined) {
      this.#meta.set(key, value)
      return
    }
    await this.#database.runQuery('INSERT OR REPLACE INTO index_meta(key, value) VALUES (?, ?)', [
      key,
      value,
    ])
  }

  async #writeNotes(notes: readonly IndexedNote[]): Promise<void> {
    const database = this.#database
    for (const note of notes) {
      if (database !== undefined) {
        await database.runQuery('DELETE FROM notes WHERE path = ?', [note.path])
        database.applyProjection(note)
      }
      this.#appliedNotes.push(note)
    }
  }

  /**
   * Re-key every row of `from` to `to`, statement for statement like `index_move`.
   */
  async #moveRows(from: string, to: string): Promise<void> {
    const database = this.#database
    if (database === undefined) {
      return
    }
    const run = database.runQuery
    const occupied = await run('SELECT 1 FROM notes WHERE path = ?', [to])
    if (Array.isArray(occupied) && occupied.length > 0) {
      throw new AppError('io', `cannot move note: ${to} is already indexed`)
    }
    const date = dateFromDailyPath(to)
    const dailyDate = date !== null && isIsoDate(date) ? date : null
    const restateClaim = `INSERT INTO note_claims(note_path, key, tier)
      SELECT ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM note_claims WHERE note_path = ? AND key = ?)`
    // The child tables reference `notes(path)`, so the parent-key update
    // needs deferred foreign-key checks, which only apply inside a transaction.
    await run('BEGIN', [])
    try {
      await run('PRAGMA defer_foreign_keys = ON', [])
      const moved = await run(
        'UPDATE notes SET path = ?, path_key = ? WHERE path = ? RETURNING path',
        [to, foldGraphPath(to), from],
      )
      await run('UPDATE note_claims SET note_path = ? WHERE note_path = ?', [to, from])
      if (Array.isArray(moved) && moved.length > 0) {
        await run('DELETE FROM note_claims WHERE note_path = ? AND tier IN (?, ?)', [
          to,
          CLAIM_TIER.dailyDate,
          CLAIM_TIER.basename,
        ])
        if (dailyDate !== null) {
          await run(restateClaim, [to, dailyDate, CLAIM_TIER.dailyDate, to, dailyDate])
        }
        const basenameKey = noteBasenameKey(to)
        await run(restateClaim, [to, basenameKey, CLAIM_TIER.basename, to, basenameKey])
      }
      await run('UPDATE links SET source_path = ? WHERE source_path = ?', [to, from])
      for (const table of [
        'tags',
        'aliases',
        'note_emails',
        'assets',
        'tasks',
        'embedding_chunks',
      ]) {
        await run(`UPDATE ${table} SET note_path = ? WHERE note_path = ?`, [to, from])
      }
      await run('UPDATE search_fts SET path = ? WHERE path = ?', [to, from])
      await run('COMMIT', [])
    } catch (error) {
      await run('ROLLBACK', [])
      throw error
    }
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
