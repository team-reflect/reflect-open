import sqlite3InitModule, { type Database, type SqlValue } from '@sqlite.org/sqlite-wasm'
import {
  CLAIM_TIER,
  dateFromDailyPath,
  encodeTaskBreadcrumbs,
  foldGraphPath,
  isCalendarDate,
  noteBasenameKey,
  ReflectError,
  type IndexedNote,
} from '@reflect/core'

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
  /** Re-stamp a row's `mtime`/`updated_at` (one `index_touch` entry). */
  touchNote: (path: string, mtime: number) => void
  /** Wipe derived tables, preserving `index_meta` (`index_clear`). */
  clear: () => void
  /** Upsert one `index_meta` key (`index_meta_set`). */
  setMeta: (key: string, value: string) => void
  /** Upsert one chat turn + its conversation row (`chat_message_save`). */
  saveChatMessage: (conversation: DevChatConversation, message: DevChatMessageRow) => void
  /** Persist a prepared note-change checkpoint (`chat_note_change_prepare`). */
  prepareChatNoteChange: (change: DevChatNoteChangeInput) => DevChatNoteChange
  /** Compare-and-set a checkpoint lifecycle state (`chat_note_change_set_state`). */
  setChatNoteChangeState: (input: DevChatNoteChangeStateInput) => DevChatNoteChangeStateResult
  /** Atomically compare-and-set an Undo group's checkpoint states. */
  setChatNoteChangesStateBatch: (
    input: DevChatNoteChangesStateInput,
  ) => DevChatNoteChangesStateResult
  /** Ordered checkpoints belonging to one chat turn. */
  chatNoteChangesForTurn: (turnId: string) => DevChatNoteChange[]
  /** Checkpoints requiring launch-time recovery. */
  pendingChatNoteChanges: () => DevChatNoteChange[]
  /** Delete a conversation; its messages cascade (`chat_conversation_delete`). */
  deleteChatConversation: (id: string) => void
}

/** Mirrors `chat_write.rs`'s `ChatConversation` (camelCased over IPC). */
export interface DevChatConversation {
  id: string
  title: string
  createdMs: number
  updatedMs: number
}

/** Mirrors `chat_write.rs`'s `ChatMessageRow`: the JSON columns stay opaque strings. */
export interface DevChatMessageRow {
  id: string
  conversationId: string
  userText: string
  attachments: string
  parts: string
  responseMessages: string
  permissionMode?: 'read' | 'readWrite'
  sourceProvenance?: string | null
  createdMs: number
}

export type DevChatNoteChangeOperation = 'edit' | 'append' | 'create'
export type DevChatNoteChangeState =
  | 'prepared'
  | 'applied'
  | 'undoing'
  | 'undone'
  | 'failed'
  | 'uncertain'

export interface DevChatNoteChangeInput {
  id: string
  conversationId: string
  turnId: string
  toolCallId: string
  path: string
  sequence: number
  operation: DevChatNoteChangeOperation
  beforeSource: string | null
  afterSource: string
  beforeRevision: string | null
  afterRevision: string
  createdMs: number
}

export interface DevChatNoteChange extends DevChatNoteChangeInput {
  state: DevChatNoteChangeState
  errorMessage: string | null
  updatedMs: number
}

export interface DevChatNoteChangeStateInput {
  id: string
  expectedState: DevChatNoteChangeState
  state: DevChatNoteChangeState
  errorMessage: string | null
  updatedMs: number
}

export type DevChatNoteChangeStateResult =
  | { kind: 'updated'; change: DevChatNoteChange }
  | { kind: 'stateMismatch'; change: DevChatNoteChange }
  | { kind: 'missing' }

export interface DevChatNoteChangesStateInput {
  ids: string[]
  expectedState: DevChatNoteChangeState
  state: DevChatNoteChangeState
  errorMessage: string | null
  updatedMs: number
}

export type DevChatNoteChangesStateResult =
  | { kind: 'updated'; changes: DevChatNoteChange[] }
  | { kind: 'stateMismatch'; changes: DevChatNoteChange[] }
  | { kind: 'missing'; missingIds: string[] }

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
  return sql.replaceAll(
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
  const journalSessionId = crypto.randomUUID()

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
        `INSERT INTO notes(path, id, title, title_key, path_key, kind, daily_date, is_private, is_pinned, pinned_order, has_conflict, gist_url, gist_stale, file_hash, mtime, updated_at, preview)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          note.path,
          note.id,
          note.title,
          note.titleKey,
          note.pathKey,
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
          `INSERT INTO links(source_path, kind, target_raw, target_key, target_path_key, alias, pos_from, pos_to)
           VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            note.path,
            link.kind,
            link.targetRaw,
            link.targetKey,
            link.targetPathKey,
            link.alias,
            link.posFrom,
            link.posTo,
          ],
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
      for (const claim of note.claims) {
        run(db, 'INSERT INTO note_claims(note_path, key, tier) VALUES(?, ?, ?)', [
          note.path,
          claim.key,
          claim.tier,
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
          'INSERT INTO tasks(note_path, marker_offset, text, breadcrumbs, raw, checked, due_date) VALUES(?, ?, ?, ?, ?, ?, ?)',
          [
            note.path,
            task.markerOffset,
            task.text,
            encodeTaskBreadcrumbs(task.breadcrumbs),
            task.raw,
            task.checked,
            task.dueDate,
          ],
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
        run(db, 'UPDATE notes SET path = ?, path_key = ? WHERE path = ?', [
          to,
          foldGraphPath(to),
          from,
        ])
        const movedRows = db.changes()
        // Mirrors `write.rs`: carried claims follow the row; the path-derived
        // tiers are re-stated for the destination. A missing source row moves
        // nothing and must not mint claims for a note that does not exist.
        run(db, 'UPDATE note_claims SET note_path = ? WHERE note_path = ?', [to, from])
        if (movedRows > 0) {
          run(db, 'DELETE FROM note_claims WHERE note_path = ? AND tier IN (?, ?)', [
            to,
            CLAIM_TIER.dailyDate,
            CLAIM_TIER.basename,
          ])
          const date = dateFromDailyPath(to)
          const restated = [
            ...(date !== null && isCalendarDate(date)
              ? [{ key: date, tier: CLAIM_TIER.dailyDate }]
              : []),
            { key: noteBasenameKey(to), tier: CLAIM_TIER.basename },
          ]
          for (const claim of restated) {
            run(
              db,
              `INSERT INTO note_claims(note_path, key, tier)
               SELECT ?, ?, ?
               WHERE NOT EXISTS (SELECT 1 FROM note_claims WHERE note_path = ? AND key = ?)`,
              [to, claim.key, claim.tier, to, claim.key],
            )
          }
        }
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

    touchNote: (path, mtime) => {
      run(db, 'UPDATE notes SET mtime = ?, updated_at = ? WHERE path = ?', [mtime, mtime, path])
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

    // The chat writes mirror `chat_write.rs` statement-for-statement: the
    // conversation keeps its original title/created_ms and bumps updated_ms,
    // seq is assigned inside the insert (never by the caller), and the
    // message upserts by primary key — deliberately not INSERT OR REPLACE.
    saveChatMessage: (conversation, message) => {
      run(
        db,
        `INSERT INTO chat_conversations(id, title, created_ms, updated_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_ms = excluded.updated_ms`,
        [conversation.id, conversation.title, conversation.createdMs, conversation.updatedMs],
      )
      run(
        db,
        `INSERT INTO chat_messages(
            id, conversation_id, seq, user_text, attachments, parts,
            response_messages, permission_mode, source_provenance, created_ms)
         VALUES (
            ?1, ?2,
            (SELECT COALESCE(MAX(seq) + 1, 0) FROM chat_messages WHERE conversation_id = ?2),
            ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(id) DO UPDATE SET
            user_text = excluded.user_text,
            attachments = excluded.attachments,
            parts = excluded.parts,
            response_messages = excluded.response_messages,
            permission_mode = excluded.permission_mode,
            source_provenance = excluded.source_provenance`,
        [
          message.id,
          message.conversationId,
          message.userText,
          message.attachments,
          message.parts,
          message.responseMessages,
          message.permissionMode ?? 'read',
          message.sourceProvenance ?? null,
          message.createdMs,
        ],
      )
    },

    prepareChatNoteChange: (change) => {
      const belongs = db.selectValue(
        'SELECT EXISTS(SELECT 1 FROM chat_messages WHERE id = ? AND conversation_id = ?)',
        [change.turnId, change.conversationId],
      )
      if (Number(belongs) !== 1) {
        throw new ReflectError(
          'notFound',
          `chat message ${change.turnId} does not belong to ${change.conversationId}`,
        )
      }
      run(
        db,
        `INSERT INTO chat_note_changes(
           id, conversation_id, message_id, tool_call_id, path, seq, operation,
           before_source, after_source, before_revision, after_revision, state,
           owner_session, error_message, created_ms, updated_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, NULL, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        [
          change.id,
          change.conversationId,
          change.turnId,
          change.toolCallId,
          change.path,
          change.sequence,
          change.operation,
          change.beforeSource,
          change.afterSource,
          change.beforeRevision,
          change.afterRevision,
          journalSessionId,
          change.createdMs,
          change.createdMs,
        ],
      )
      const stored = loadDevChatNoteChange(db, change.id)
      if (stored === null || !samePreparedChange(stored, change)) {
        throw new ReflectError('io', `chat note change ${change.id} was reused`)
      }
      const storedOwner = db.selectValue(
        'SELECT owner_session FROM chat_note_changes WHERE id = ?',
        [change.id],
      )
      if (storedOwner !== journalSessionId) {
        throw new ReflectError(
          'io',
          `chat note change ${change.id} belongs to an earlier process session`,
        )
      }
      return stored
    },

    setChatNoteChangeState: (input) => {
      if (!canTransitionChatNoteChange(input.expectedState, input.state)) {
        throw new ReflectError(
          'io',
          `invalid chat note change transition: ${input.expectedState} -> ${input.state}`,
        )
      }
      const before = loadDevChatNoteChange(db, input.id)
      if (before === null) {
        return { kind: 'missing' }
      }
      if (before.state !== input.expectedState) {
        return { kind: 'stateMismatch', change: before }
      }
      run(
        db,
        `UPDATE chat_note_changes
         SET state = ?,
             owner_session = CASE WHEN ? = 'undoing' THEN ? ELSE owner_session END,
             error_message = ?, updated_ms = ?
         WHERE id = ? AND state = ?`,
        [
          input.state,
          input.state,
          journalSessionId,
          input.errorMessage,
          input.updatedMs,
          input.id,
          input.expectedState,
        ],
      )
      const change = loadDevChatNoteChange(db, input.id)
      if (change === null) {
        return { kind: 'missing' }
      }
      return { kind: 'updated', change }
    },

    setChatNoteChangesStateBatch: (input) => {
      if (input.ids.length === 0) {
        throw new ReflectError('io', 'chat note change batch must not be empty')
      }
      if (new Set(input.ids).size !== input.ids.length) {
        throw new ReflectError('io', 'chat note change batch contains duplicate ids')
      }
      if (!canTransitionChatNoteChange(input.expectedState, input.state)) {
        throw new ReflectError(
          'io',
          `invalid chat note change transition: ${input.expectedState} -> ${input.state}`,
        )
      }

      run(db, 'BEGIN IMMEDIATE')
      try {
        const changes = input.ids.flatMap((id) => {
          const change = loadDevChatNoteChange(db, id)
          return change === null ? [] : [change]
        })
        const found = new Set(changes.map((change) => change.id))
        const missingIds = input.ids.filter((id) => !found.has(id))
        if (missingIds.length > 0) {
          run(db, 'COMMIT')
          return { kind: 'missing', missingIds }
        }
        if (changes.some((change) => change.state !== input.expectedState)) {
          run(db, 'COMMIT')
          return { kind: 'stateMismatch', changes }
        }

        for (const id of input.ids) {
          run(
            db,
            `UPDATE chat_note_changes
             SET state = ?,
                 owner_session = CASE WHEN ? = 'undoing' THEN ? ELSE owner_session END,
                 error_message = ?, updated_ms = ?
             WHERE id = ? AND state = ?`,
            [
              input.state,
              input.state,
              journalSessionId,
              input.errorMessage,
              input.updatedMs,
              id,
              input.expectedState,
            ],
          )
        }
        const updated = input.ids.map((id) => {
          const change = loadDevChatNoteChange(db, id)
          if (change === null) {
            throw new ReflectError('io', `chat note change ${id} disappeared during batch update`)
          }
          return change
        })
        run(db, 'COMMIT')
        return { kind: 'updated', changes: updated }
      } catch (error) {
        run(db, 'ROLLBACK')
        throw error
      }
    },

    chatNoteChangesForTurn: (turnId) =>
      selectDevChatNoteChanges(
        db,
        'SELECT * FROM chat_note_changes WHERE message_id = ? ORDER BY seq',
        [turnId],
      ),

    pendingChatNoteChanges: () =>
      selectDevChatNoteChanges(
        db,
        `SELECT * FROM chat_note_changes
         WHERE state = 'uncertain'
            OR (state IN ('prepared', 'undoing') AND owner_session <> ?)
         ORDER BY created_ms, message_id, seq`,
        [journalSessionId],
      ),

    deleteChatConversation: (id) => {
      const unfinished = db.selectValue(
        `SELECT EXISTS(
           SELECT 1 FROM chat_note_changes
           WHERE conversation_id = ? AND owner_session = ?
             AND state IN ('prepared', 'undoing'))`,
        [id, journalSessionId],
      )
      if (Number(unfinished) === 1) {
        throw new ReflectError('io', 'conversation has unfinished note changes')
      }
      run(db, 'DELETE FROM chat_conversations WHERE id = ?', [id])
    },
  }
}

function canTransitionChatNoteChange(
  current: DevChatNoteChangeState,
  next: DevChatNoteChangeState,
): boolean {
  return (
    current === next ||
    (current === 'prepared' && (next === 'applied' || next === 'failed' || next === 'uncertain')) ||
    (current === 'applied' && (next === 'undoing' || next === 'uncertain')) ||
    (current === 'undoing' && (next === 'undone' || next === 'applied' || next === 'uncertain')) ||
    (current === 'uncertain' && (next === 'applied' || next === 'failed' || next === 'undone'))
  )
}

function selectDevChatNoteChanges(
  db: Database,
  sql: string,
  params: readonly unknown[],
): DevChatNoteChange[] {
  const resultRows: Record<string, SqlValue>[] = []
  db.exec({ sql, bind: params.map(bindValue), rowMode: 'object', resultRows })
  return resultRows.map(devChatNoteChangeFromRow)
}

function loadDevChatNoteChange(db: Database, id: string): DevChatNoteChange | null {
  return (
    selectDevChatNoteChanges(db, 'SELECT * FROM chat_note_changes WHERE id = ?', [id])[0] ?? null
  )
}

function devChatNoteChangeFromRow(row: Record<string, SqlValue>): DevChatNoteChange {
  const operation = row['operation']
  const state = row['state']
  if (operation === undefined || state === undefined) {
    throw new ReflectError('io', 'chat note change row is missing operation or state')
  }
  return {
    id: String(row['id']),
    conversationId: String(row['conversation_id']),
    turnId: String(row['message_id']),
    toolCallId: String(row['tool_call_id']),
    path: String(row['path']),
    sequence: Number(row['seq']),
    operation: devChatNoteChangeOperation(operation),
    beforeSource: row['before_source'] === null ? null : String(row['before_source']),
    afterSource: String(row['after_source']),
    beforeRevision: row['before_revision'] === null ? null : String(row['before_revision']),
    afterRevision: String(row['after_revision']),
    state: devChatNoteChangeState(state),
    errorMessage: row['error_message'] === null ? null : String(row['error_message']),
    createdMs: Number(row['created_ms']),
    updatedMs: Number(row['updated_ms']),
  }
}

function devChatNoteChangeOperation(value: SqlValue): DevChatNoteChangeOperation {
  if (value === 'edit' || value === 'append' || value === 'create') {
    return value
  }
  throw new ReflectError('io', `invalid chat note change operation: ${String(value)}`)
}

function devChatNoteChangeState(value: SqlValue): DevChatNoteChangeState {
  if (
    value === 'prepared' ||
    value === 'applied' ||
    value === 'undoing' ||
    value === 'undone' ||
    value === 'failed' ||
    value === 'uncertain'
  ) {
    return value
  }
  throw new ReflectError('io', `invalid chat note change state: ${String(value)}`)
}

function samePreparedChange(stored: DevChatNoteChange, input: DevChatNoteChangeInput): boolean {
  return (
    stored.id === input.id &&
    stored.conversationId === input.conversationId &&
    stored.turnId === input.turnId &&
    stored.toolCallId === input.toolCallId &&
    stored.path === input.path &&
    stored.sequence === input.sequence &&
    stored.operation === input.operation &&
    stored.beforeSource === input.beforeSource &&
    stored.afterSource === input.afterSource &&
    stored.beforeRevision === input.beforeRevision &&
    stored.afterRevision === input.afterRevision &&
    stored.createdMs === input.createdMs
  )
}

function removeNote(db: Database, path: string): void {
  run(db, 'DELETE FROM notes WHERE path = ?', [path])
  run(db, 'DELETE FROM search_fts WHERE path = ?', [path])
}
