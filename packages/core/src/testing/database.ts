import type { IndexReadCommand, IndexWriteCommand } from '@reflect/types'
import { createWasmIndexBackend, type WasmIndexBackend } from '@reflect/index-wasm'
import { toAppError } from '../errors.ts'
import type { DatabaseService } from '../indexing/database-service.ts'
import { buildIndexedNote, type IndexedNote } from '../indexing/indexed-note.ts'
import type { CommandArgs, CommandResult } from '../ipc/ipc-service.ts'
import { parseNote } from '../markdown/extract.ts'

/**
 * One read command the database ran.
 */
export interface TestDatabaseRead {
  readonly command: string
  readonly args: Readonly<Record<string, unknown>>
}

/**
 * The name of every command that writes or reads the index.
 */
export type IndexCommand = IndexWriteCommand | IndexReadCommand

export interface TestDatabaseService extends DatabaseService {
  /**
   * Replace every projected row of `note.path` with `note`, like `index_apply`.
   */
  applyProjection(note: IndexedNote): void
  /**
   * Run one read-only SQL statement and return its rows, with the column
   * names of the schema. For assertions on rows that no read command returns.
   */
  query(sql: string, params?: readonly unknown[]): Record<string, unknown>[]
  /**
   * Run one index command on the database, like the native shell.
   */
  invoke<C extends IndexCommand>(command: C, args: CommandArgs<C>): CommandResult<C>
  /**
   * The generation of the open index, which a write command must carry.
   */
  generation(): number
  /**
   * Every read command run through `read` so far, in order.
   */
  getReads(): readonly TestDatabaseRead[]
  /**
   * Release the database; later queries and seeding throw.
   */
  close(): void
}

class TestDatabaseServiceImpl implements TestDatabaseService {
  readonly #reads: TestDatabaseRead[] = []
  #index: WasmIndexBackend | null = null
  #generation = 0
  #closed = false

  query(sql: string, params: readonly unknown[] = []): Record<string, unknown>[] {
    return this.#invoke('test_query', { sql, params: [...params] }) as Record<string, unknown>[]
  }

  read<C extends IndexReadCommand>(command: C, args: CommandArgs<C>): Promise<CommandResult<C>> {
    return Promise.try(() => {
      this.#reads.push({ command, args: structuredClone(args) })
      return this.invoke(command, args)
    })
  }

  applyProjection(note: IndexedNote): void {
    this.invoke('index_apply', { note, generation: this.generation() })
  }

  invoke<C extends IndexCommand>(command: C, args: CommandArgs<C>): CommandResult<C> {
    return this.#invoke(command, args) as CommandResult<C>
  }

  generation(): number {
    this.#open()
    return this.#generation
  }

  getReads(): readonly TestDatabaseRead[] {
    return [...this.#reads]
  }

  close(): void {
    this.#closed = true
    this.#index?.close()
    this.#index = null
  }

  #invoke(command: string, args: Readonly<Record<string, unknown>>): unknown {
    try {
      return this.#open().invoke(command, args as Record<string, unknown>)
    } catch (error) {
      throw toAppError(error)
    }
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
export function createTestDatabaseService(): TestDatabaseService {
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
