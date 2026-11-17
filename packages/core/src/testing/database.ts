import { createDb } from '@reflect/db'
import { createWasmIndexBackend, type WasmIndexBackend } from '@reflect/index-wasm'
import { toAppError } from '../errors.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { buildIndexedNote, type IndexedNote } from '../indexing/indexed-note.ts'
import { parseNote } from '../markdown/extract.ts'

/**
 * One query the database ran, in its compiled form.
 */
export interface TestDatabaseQuery {
  readonly sql: string
  readonly params: readonly unknown[]
}

export interface TestDatabaseService extends DatabaseService {
  /**
   * Replace every projected row of `note.path` with `note`, like `index_apply`.
   */
  applyProjection(note: IndexedNote): void
  /**
   * Whether `invoke` answers `command`.
   */
  has(command: string): boolean
  /**
   * Run one index command on the database, like the native shell.
   */
  invoke(command: string, args: Record<string, unknown>): unknown
  /**
   * The generation of the open index, which a write command must carry.
   */
  generation(): number
  /**
   * Every query run so far, in order.
   */
  getQueries(): readonly TestDatabaseQuery[]
  /**
   * Release the database; later queries and seeding throw.
   */
  close(): void
}

class TestDatabaseServiceImpl implements TestDatabaseService {
  readonly db: DatabaseService['db']
  readonly #queries: TestDatabaseQuery[] = []
  #index: WasmIndexBackend | null = null
  #generation = 0
  #closed = false

  constructor() {
    this.db = createDb(this.runQuery)
  }

  readonly runQuery = (sql: string, params: readonly unknown[]): Promise<unknown> => {
    return Promise.try(() => {
      this.#queries.push({ sql, params: [...params] })
      return this.invoke('db_query', { sql, params: [...params] })
    })
  }

  applyProjection(note: IndexedNote): void {
    this.invoke('index_apply', { note, generation: this.generation() })
  }

  has(command: string): boolean {
    return this.#open().has(command)
  }

  invoke(command: string, args: Record<string, unknown>): unknown {
    try {
      const result = this.#open().invoke(command, args)
      if (command === 'index_open') {
        this.#generation = result as number
      }
      return result
    } catch (error) {
      throw toAppError(error)
    }
  }

  generation(): number {
    this.#open()
    return this.#generation
  }

  getQueries(): readonly TestDatabaseQuery[] {
    return [...this.#queries]
  }

  close(): void {
    this.#closed = true
    this.#index?.close()
    this.#index = null
  }

  #open(): WasmIndexBackend {
    if (this.#closed) {
      throw new Error('the test database is closed')
    }
    if (this.#index === null) {
      this.#index = createWasmIndexBackend()
      this.#generation = this.#index.invoke('index_open', {}) as number
    }
    return this.#index
  }
}

/**
 * A {@link DatabaseService} over the index of the native shells, compiled to
 * wasm, with a new in-memory database. The database opens on first use, so
 * building one is cheap.
 */
export function createNodeTestDatabaseService(): TestDatabaseService {
  return new TestDatabaseServiceImpl()
}

/**
 * One note to project into a test index from its markdown.
 */
export interface TestNote {
  /**
   * Graph-relative path.
   */
  readonly path: string
  /**
   * The file contents.
   */
  readonly markdown: string
  /**
   * File modification time (epoch ms); defaults to 0.
   */
  readonly mtime?: number
}

/**
 * Project each note through the real markdown indexing pipeline into `database`.
 */
export function seedNotes(database: TestDatabaseService, notes: readonly TestNote[]): void {
  for (const { path, markdown, mtime } of notes) {
    database.applyProjection(
      buildIndexedNote(parseNote({ path, source: markdown }), {
        fileHash: `hash-${path}`,
        mtime: mtime ?? 0,
        source: markdown,
      }),
    )
  }
}
