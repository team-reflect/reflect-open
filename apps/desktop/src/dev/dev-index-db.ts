import sqlite3InitModule, { type Database, type SqlValue } from '@sqlite.org/sqlite-wasm'
import { ReflectError, type IndexedNote } from '@reflect/core'

/**
 * The dev bridge's SQLite index: the real `crates/index-schema` migrations
 * running in the browser via the official SQLite wasm build, so `db_query`
 * executes the exact SQL Kysely compiles — FTS5 search included. Write
 * commands mirror `src-tauri/src/db/write.rs` statement-for-statement.
 */
export interface DevIndexDb {
  /** Execute a read query (the `db_query` contract): rows as column-keyed objects. */
  query: (sql: string, params: readonly unknown[]) => Record<string, SqlValue>[]
  /** Replace all rows for `note.path` with its projection (`index_apply`). */
  applyNote: (note: IndexedNote) => void
  /** Drop every row belonging to `path` (`index_remove`). */
  removeNote: (path: string) => void
  /** Re-key every row from `from` to `to` (`index_move`); throws when `to` is occupied. */
  moveNote: (from: string, to: string) => void
  /** Wipe derived tables, preserving `index_meta` (`index_clear`). */
  clear: () => void
  /** Upsert one `index_meta` key (`index_meta_set`). */
  setMeta: (key: string, value: string) => void
}

// The real migrations, inlined at build time. This chunk only loads behind the
// DEV platform override, so the raw SQL never reaches production bundles.
const migrationSources = import.meta.glob<string>(
  '../../../../crates/index-schema/migrations/*.sql',
  { query: '?raw', import: 'default', eager: true },
)

/**
 * `vec0` is the sqlite-vec native extension, absent from the wasm build. The
 * mobile surfaces never touch embedding vectors (semantic search is desktop-
 * only and off by default), so a plain single-column table keeps the DDL —
 * and 0003's copy-and-drop migration dance — valid without the module.
 */
function stubVectorTables(sql: string): string {
  return sql.replace(
    /CREATE VIRTUAL TABLE (\S+) USING vec0\([^)]*\)/g,
    'CREATE TABLE $1 (embedding BLOB)',
  )
}

/** Coerce a Kysely-bound parameter to something SQLite can bind (mirrors `json_to_sql`). */
function bindValue(value: unknown): SqlValue {
  if (value === null || value === undefined) {
    return null
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value
  }
  if (value instanceof Uint8Array) {
    return value
  }
  return JSON.stringify(value)
}

function run(db: Database, sql: string, params: readonly unknown[] = []): void {
  db.exec({ sql, bind: params.map(bindValue) })
}

/** Open an in-memory index database and apply every migration in order. */
export async function createDevIndexDb(): Promise<DevIndexDb> {
  const sqlite3 = await sqlite3InitModule()
  const db = new sqlite3.oo1.DB()
  // The schema relies on ON DELETE CASCADE (removing a `notes` row clears its
  // child tables); SQLite ships with foreign keys off per connection.
  db.exec('PRAGMA foreign_keys = ON')
  const migrations = Object.entries(migrationSources).sort(([a], [b]) => a.localeCompare(b))
  for (const [, source] of migrations) {
    db.exec(stubVectorTables(source))
  }

  return {
    query: (sql, params) => {
      const resultRows: Record<string, SqlValue>[] = []
      db.exec({ sql, bind: params.map(bindValue), rowMode: 'object', resultRows })
      return resultRows
    },

    applyNote: (note) => {
      removeNote(db, note.path)
      run(
        db,
        `INSERT INTO notes(path, id, title, title_key, kind, daily_date, is_private, is_pinned, pinned_order, has_conflict, gist_url, gist_stale, file_hash, mtime, updated_at, preview)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          note.path,
          note.id,
          note.title,
          note.titleKey,
          note.kind,
          note.dailyDate,
          note.isPrivate,
          note.isPinned,
          note.pinnedOrder,
          note.hasConflict,
          note.gistUrl,
          note.gistStale,
          note.fileHash,
          note.mtime,
          note.mtime,
          note.preview,
        ],
      )
      run(db, 'INSERT INTO note_text(note_path, text) VALUES(?, ?)', [note.path, note.text])
      for (const link of note.links) {
        run(
          db,
          `INSERT INTO links(source_path, kind, target_raw, target_key, alias, pos_from, pos_to)
           VALUES(?, ?, ?, ?, ?, ?, ?)`,
          [note.path, link.kind, link.targetRaw, link.targetKey, link.alias, link.posFrom, link.posTo],
        )
      }
      for (const tag of note.tags) {
        run(db, 'INSERT INTO tags(note_path, tag, tag_key) VALUES(?, ?, ?)', [
          note.path,
          tag.tag,
          tag.tagKey,
        ])
      }
      for (const alias of note.aliases) {
        run(db, 'INSERT INTO aliases(note_path, alias, alias_key) VALUES(?, ?, ?)', [
          note.path,
          alias.alias,
          alias.aliasKey,
        ])
      }
      for (const email of note.emails) {
        run(db, 'INSERT INTO note_emails(note_path, email, email_key) VALUES(?, ?, ?)', [
          note.path,
          email.email,
          email.emailKey,
        ])
      }
      for (const asset of note.assets) {
        run(db, 'INSERT INTO assets(note_path, asset_path) VALUES(?, ?)', [note.path, asset])
      }
      for (const task of note.tasks) {
        run(
          db,
          'INSERT INTO tasks(note_path, marker_offset, text, raw, checked, due_date) VALUES(?, ?, ?, ?, ?, ?)',
          [note.path, task.markerOffset, task.text, task.raw, task.checked, task.dueDate],
        )
      }
      const searchBody = note.assetText === '' ? note.text : `${note.text}\n${note.assetText}`
      run(db, 'INSERT INTO search_fts(path, title, body) VALUES(?, ?, ?)', [
        note.path,
        note.title,
        searchBody,
      ])
    },

    removeNote: (path) => removeNote(db, path),

    moveNote: (from, to) => {
      const occupied = db.selectValue('SELECT 1 FROM notes WHERE path = ?', [to])
      if (occupied !== undefined) {
        throw new ReflectError('io', `cannot move note: ${to} is already indexed`)
      }
      // Mirrors the Rust caller: the child tables reference `notes(path)`, so
      // the parent-key update needs deferred FK checks — which only apply
      // inside a transaction (the pragma resets at COMMIT).
      db.exec('BEGIN')
      try {
        db.exec('PRAGMA defer_foreign_keys = ON')
        run(db, 'UPDATE notes SET path = ? WHERE path = ?', [to, from])
        run(db, 'UPDATE note_text SET note_path = ? WHERE note_path = ?', [to, from])
        run(db, 'UPDATE links SET source_path = ? WHERE source_path = ?', [to, from])
        run(db, 'UPDATE tags SET note_path = ? WHERE note_path = ?', [to, from])
        run(db, 'UPDATE aliases SET note_path = ? WHERE note_path = ?', [to, from])
        run(db, 'UPDATE note_emails SET note_path = ? WHERE note_path = ?', [to, from])
        run(db, 'UPDATE assets SET note_path = ? WHERE note_path = ?', [to, from])
        run(db, 'UPDATE tasks SET note_path = ? WHERE note_path = ?', [to, from])
        run(db, 'UPDATE embedding_chunks SET note_path = ? WHERE note_path = ?', [to, from])
        run(db, 'UPDATE search_fts SET path = ? WHERE path = ?', [to, from])
        db.exec('COMMIT')
      } catch (cause) {
        db.exec('ROLLBACK')
        throw cause
      }
    },

    clear: () => {
      db.exec(
        `DELETE FROM notes; DELETE FROM search_fts;
         DELETE FROM embedding_vectors; DELETE FROM embedding_chunks;`,
      )
    },

    setMeta: (key, value) => {
      run(
        db,
        'INSERT INTO index_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        [key, value],
      )
    },
  }
}

function removeNote(db: Database, path: string): void {
  run(db, 'DELETE FROM notes WHERE path = ?', [path])
  run(db, 'DELETE FROM search_fts WHERE path = ?', [path])
}
