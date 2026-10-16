import { createDb } from '@reflect/db'
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import type { getLoadablePath } from 'sqlite-vec'
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
   * Every query run so far, in order.
   */
  getQueries(): readonly TestDatabaseQuery[]
  /**
   * Release the database; later queries and seeding throw.
   */
  close(): void
}

const MIGRATIONS_DIRECTORY = new URL('../../../../crates/index-schema/migrations/', import.meta.url)

function nodeBuiltins(): Pick<NodeJS.Process, 'getBuiltinModule'> {
  if (typeof process === 'undefined' || typeof process.getBuiltinModule !== 'function') {
    throw new TypeError(
      'createTestDatabaseService needs Node.js; browser tests install a backend with setTestDatabaseOpener',
    )
  }
  return process
}

function openMigratedIndex(): DatabaseSync {
  const node = nodeBuiltins()
  const { DatabaseSync } = node.getBuiltinModule('node:sqlite')
  const { readFileSync, readdirSync } = node.getBuiltinModule('node:fs')
  const { fileURLToPath } = node.getBuiltinModule('node:url')
  const { createRequire } = node.getBuiltinModule('node:module')
  const sqliteVec = createRequire(import.meta.url)('sqlite-vec') as {
    getLoadablePath: typeof getLoadablePath
  }
  const directory = fileURLToPath(MIGRATIONS_DIRECTORY)
  const database = new DatabaseSync(':memory:', { allowExtension: true })
  try {
    // Keep this an exact production migration chain: 0002/0003 create vec0
    // tables, so their native extension must be available before replay.
    database.loadExtension(sqliteVec.getLoadablePath())
    const migrations = readdirSync(directory)
      .filter((filename) => filename.endsWith('.sql'))
      .sort()
    for (const migration of migrations) {
      database.exec(readFileSync(`${directory}/${migration}`, 'utf8'))
    }
    return database
  } catch (error) {
    database.close()
    throw error
  }
}

function sqliteParameter(value: unknown): SQLInputValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    value instanceof Uint8Array
  ) {
    return value
  }
  throw new TypeError(`unsupported SQLite parameter: ${typeof value}`)
}

function insertProjection(database: DatabaseSync, indexed: IndexedNote): void {
  database.prepare('DELETE FROM notes WHERE path = ?').run(indexed.path)
  database.prepare('DELETE FROM search_fts WHERE path = ?').run(indexed.path)
  database
    .prepare(
      `INSERT INTO notes(
        path, id, title, title_key, path_key, kind, daily_date, is_private, is_pinned,
        pinned_order, gist_url, gist_stale, file_hash, mtime, updated_at,
        preview, has_content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      indexed.path,
      indexed.id,
      indexed.title,
      indexed.titleKey,
      indexed.pathKey,
      indexed.kind,
      indexed.dailyDate,
      Number(indexed.isPrivate),
      Number(indexed.isPinned),
      indexed.pinnedOrder,
      indexed.gistUrl,
      Number(indexed.gistStale),
      indexed.fileHash,
      indexed.mtime,
      indexed.mtime,
      indexed.preview,
      Number(indexed.hasContent),
    )

  const insertLink = database.prepare(
    `INSERT INTO links(
      source_path, kind, target_raw, target_key, target_path_key, alias, pos_from, pos_to
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const link of indexed.links) {
    insertLink.run(
      indexed.path,
      link.kind,
      link.targetRaw,
      link.targetKey,
      link.targetPathKey,
      link.alias,
      link.posFrom,
      link.posTo,
    )
  }

  const insertTag = database.prepare('INSERT INTO tags(note_path, tag, tag_key) VALUES (?, ?, ?)')
  for (const tag of indexed.tags) {
    insertTag.run(indexed.path, tag.tag, tag.tagKey)
  }

  const insertAlias = database.prepare(
    'INSERT INTO aliases(note_path, alias, alias_key) VALUES (?, ?, ?)',
  )
  for (const alias of indexed.aliases) {
    insertAlias.run(indexed.path, alias.alias, alias.aliasKey)
  }

  const insertClaim = database.prepare(
    'INSERT INTO note_claims(note_path, key, tier) VALUES (?, ?, ?)',
  )
  for (const claim of indexed.claims) {
    insertClaim.run(indexed.path, claim.key, claim.tier)
  }

  const insertEmail = database.prepare(
    'INSERT INTO note_emails(note_path, email, email_key) VALUES (?, ?, ?)',
  )
  for (const email of indexed.emails) {
    insertEmail.run(indexed.path, email.email, email.emailKey)
  }

  const insertAsset = database.prepare('INSERT INTO assets(note_path, asset_path) VALUES (?, ?)')
  for (const asset of indexed.assets) {
    insertAsset.run(indexed.path, asset)
  }

  const insertTask = database.prepare(
    `INSERT INTO tasks(note_path, ast_path, markdown, breadcrumbs, checked, due_date)
    VALUES (?, ?, ?, ?, ?, ?)`,
  )
  for (const task of indexed.tasks) {
    insertTask.run(
      indexed.path,
      task.astPath,
      task.markdown,
      JSON.stringify(task.breadcrumbs),
      Number(task.checked),
      task.dueDate,
    )
  }

  // The FTS body carries the note text plus its assets' description text.
  const searchBody =
    indexed.assetText === '' ? indexed.text : `${indexed.text}\n${indexed.assetText}`
  database
    .prepare('INSERT INTO search_fts(path, title, body) VALUES (?, ?, ?)')
    .run(indexed.path, indexed.title, searchBody)
}

/**
 * Opens the database behind a {@link createLazyTestDatabaseService}.
 */
export type TestDatabaseOpener = () => Promise<TestDatabaseService>

let installedOpener: TestDatabaseOpener | null = null

/**
 * Make {@link createTestDatabaseService} return a lazy database over `open`
 * instead of the Node.js one; `null` restores the Node.js database. A browser
 * test setup installs its wasm backend here, so every test double that
 * defaults to a test database works there too.
 */
export function setTestDatabaseOpener(open: TestDatabaseOpener | null): void {
  installedOpener = open
}

class LazyTestDatabaseServiceImpl implements TestDatabaseService {
  readonly db: DatabaseService['db']
  readonly #open: TestDatabaseOpener
  readonly #queries: TestDatabaseQuery[] = []
  readonly #held: IndexedNote[] = []
  #opened: TestDatabaseService | null = null
  #opening: Promise<TestDatabaseService> | null = null
  #closed = false

  constructor(open: TestDatabaseOpener) {
    this.#open = open
    this.db = createDb(this.runQuery)
  }

  readonly runQuery = async (sql: string, params: readonly unknown[]): Promise<unknown> => {
    this.#queries.push({ sql, params: [...params] })
    try {
      this.#assertOpen()
      const database = this.#opened ?? (await this.#ensureOpened())
      return await database.runQuery(sql, params)
    } catch (error) {
      throw toAppError(error)
    }
  }

  applyProjection(note: IndexedNote): void {
    this.#assertOpen()
    if (this.#opened === null) {
      this.#held.push(note)
    } else {
      this.#opened.applyProjection(note)
    }
  }

  getQueries(): readonly TestDatabaseQuery[] {
    return [...this.#queries]
  }

  close(): void {
    this.#closed = true
    this.#opened?.close()
    this.#opened = null
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('the test database is closed')
    }
  }

  #ensureOpened(): Promise<TestDatabaseService> {
    this.#opening ??= this.#open().then((database) => {
      if (this.#closed) {
        database.close()
        this.#assertOpen()
      }
      for (const note of this.#held.splice(0)) {
        database.applyProjection(note)
      }
      this.#opened = database
      return database
    })
    return this.#opening
  }
}

/**
 * A {@link TestDatabaseService} that calls `open` on its first query and
 * never when nothing queries it. Projections applied before that are held
 * and written, in order, as soon as the database opens, so a projection
 * that the database refuses rejects the queries instead of the apply.
 */
export function createLazyTestDatabaseService(open: TestDatabaseOpener): TestDatabaseService {
  return new LazyTestDatabaseServiceImpl(open)
}

class NodeTestDatabaseServiceImpl implements TestDatabaseService {
  readonly db: DatabaseService['db']
  readonly #queries: TestDatabaseQuery[] = []
  #database: DatabaseSync | null = null
  #closed = false

  constructor() {
    this.db = createDb(this.runQuery)
  }

  readonly runQuery = async (sql: string, params: readonly unknown[]): Promise<unknown> => {
    this.#queries.push({ sql, params: [...params] })
    try {
      return this.#open()
        .prepare(sql)
        .all(...params.map(sqliteParameter))
    } catch (error) {
      throw toAppError(error)
    }
  }

  applyProjection(note: IndexedNote): void {
    insertProjection(this.#open(), note)
  }

  getQueries(): readonly TestDatabaseQuery[] {
    return [...this.#queries]
  }

  close(): void {
    this.#closed = true
    this.#database?.close()
    this.#database = null
  }

  #open(): DatabaseSync {
    if (this.#closed) {
      throw new Error('the test database is closed')
    }
    this.#database ??= openMigratedIndex()
    return this.#database
  }
}

/**
 * A {@link DatabaseService} over a real in-memory SQLite index built from the
 * production migration chain. The database opens on first use, so building
 * one is cheap. Node.js only (`node:sqlite`) unless a browser backend is
 * installed with {@link setTestDatabaseOpener}; that backend lives in the
 * desktop app because its wasm asset loading is Vite-specific.
 */
export function createTestDatabaseService(): TestDatabaseService {
  if (installedOpener !== null) {
    return createLazyTestDatabaseService(installedOpener)
  }
  return new NodeTestDatabaseServiceImpl()
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
