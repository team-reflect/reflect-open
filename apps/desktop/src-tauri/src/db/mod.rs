//! SQLite index layer (Plan 04).
//!
//! The graph's rebuildable projection lives at `<graph>/.reflect/index.sqlite`,
//! backed by the bundled SQLite (FTS5 compiled in) with sqlite-vec registered for
//! Plan 09. Parsing/extraction happens in TS (`@reflect/core`, Plan 03); this
//! module owns the schema/migrations ([`migrations`]), all writes — one
//! transaction per batch, generation-gated here in the command layer
//! ([`write`] holds the row logic) — plus a read-only `db_query` bridge
//! ([`query`]) that executes the SQL the frontend builds with Kysely. The DB
//! is *mostly* a cache: the note projection is rebuildable from markdown, but
//! the `chat_*` tables ([`chat_write`]) hold durable chat history — deleting
//! the file loses those.

mod chat_write;
mod embed_write;
mod migrations;
mod query;
mod scan;
#[cfg(test)]
mod tests;
mod write;

use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection};
use serde_json::{Map, Value};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

pub use chat_write::{ChatConversation, ChatMessageRow};
pub use embed_write::EmbeddedChunk;
pub use write::IndexedNote;

/// The open index connection plus its monotonic generation, kept **under one
/// lock** so they swap atomically. `index_open` bumps the generation and rebinds
/// the connection together; a write carries the generation it was issued for and
/// no-ops if it's stale. Because the check and the connection are read under the
/// same lock, a write can never see a fresh generation with a stale connection
/// (or vice versa) — so a reconcile/reindex pass from a previous graph can never
/// mutate a newly-opened index, regardless of caller timing (needed once the
/// watcher in Plan 04b indexes outside the serialized open flow).
///
/// The single connection also means reads (`db_query`) and writes (`index_*`)
/// are serialized — a long FTS scan briefly blocks an apply and vice versa.
/// Acceptable at first-wave scale; a read-pool / WAL reader split can come later.
#[derive(Default)]
struct IndexInner {
    generation: u64,
    conn: Option<Connection>,
}

/// The active graph's index state (`conn` is `None` until `index_open`).
#[derive(Default)]
pub struct IndexState(Mutex<IndexInner>);

fn lock_state<'a>(index: &'a State<IndexState>) -> AppResult<MutexGuard<'a, IndexInner>> {
    index.0.lock().map_err(|err| {
        // A poisoned lock means a command panicked while holding it — the panic
        // itself is the bug; this context points at the blast radius.
        tracing::error!(?err, "index state lock poisoned by an earlier panic");
        AppError::io("index state lock poisoned")
    })
}

/// The open index session's generation as a pure read, or `None` when no
/// index is open. The note-window bootstrap (`windows::window_bootstrap`)
/// adopts the session through this — it must never rebind the connection or
/// bump the generation the way `index_open` does.
pub(crate) fn current_generation(index: &State<IndexState>) -> AppResult<Option<u64>> {
    let state = lock_state(index)?;
    Ok(state.conn.is_some().then_some(state.generation))
}

/// Broadcast event fired after a note-projection write commits. Secondary
/// note windows run no indexer of their own: they refetch their index-backed
/// queries on this signal, while the main window (which did the writing)
/// invalidates in-process via the `index-applied` module and never listens.
const INDEX_WRITTEN_EVENT: &str = "index:written";

fn emit_index_written<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    let _ = app.emit(INDEX_WRITTEN_EVENT, ());
}

/// Broadcast event fired after a note's rows move to a new path (an in-app
/// rename or an id-healed external one). The in-process `followHealedMove`
/// hook only runs in the window that drove the move — a secondary note
/// window with the note open must also retarget its session, or its next
/// save would resurrect the dead file at the old path.
const NOTE_MOVED_EVENT: &str = "note:moved";

fn emit_note_moved<R: tauri::Runtime>(app: &tauri::AppHandle<R>, from: &str, to: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        NOTE_MOVED_EVENT,
        serde_json::json!({ "from": from, "to": to }),
    );
}

// ---- commands --------------------------------------------------------------

/// Open + migrate the index for the active graph (reads the root from state).
/// Returns the new generation, which write commands must echo back. The
/// generation bump and connection rebind happen under one lock, atomically.
#[tauri::command]
pub fn index_open(graph: State<GraphState>, index: State<IndexState>) -> AppResult<u64> {
    let root = graph
        .0
        .lock()
        .map_err(|err| {
            tracing::error!(?err, "graph state lock poisoned by an earlier panic");
            AppError::io("graph state lock poisoned")
        })?
        .root
        .clone()
        .ok_or_else(AppError::no_graph)?;
    let mut state = lock_state(&index)?;
    state.generation += 1;
    // Drop the old connection before opening; if the open fails we return with
    // `conn = None` (reads then error) rather than a stale connection.
    state.conn = None;
    state.conn = Some(migrations::open_index_at(&root)?);
    Ok(state.generation)
}

/// Apply a batch of note projections in a single transaction (shared by the
/// one-note and batch commands). No-op if the generation is stale — a superseded
/// pass must not write the new graph's index. One transaction + cached statements
/// keeps a full rebuild cheap; an empty batch commits a no-op transaction.
/// Returns whether it committed, so callers only broadcast real writes.
fn apply_in_txn(
    index: &State<IndexState>,
    generation: u64,
    notes: &[IndexedNote],
) -> AppResult<bool> {
    let mut state = lock_state(index)?;
    if state.generation != generation {
        return Ok(false);
    }
    let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
    let tx = conn.transaction()?;
    for note in notes {
        write::apply_note(&tx, note)?;
    }
    tx.commit()?;
    Ok(true)
}

/// Apply one note's extracted projection in a single transaction.
#[tauri::command]
pub fn index_apply<R: tauri::Runtime>(
    note: IndexedNote,
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
) -> AppResult<()> {
    if apply_in_txn(&index, generation, std::slice::from_ref(&note))? {
        emit_index_written(&app);
    }
    Ok(())
}

/// Apply many notes' projections in one transaction (the full-rebuild path).
#[tauri::command]
pub fn index_apply_batch<R: tauri::Runtime>(
    notes: Vec<IndexedNote>,
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
) -> AppResult<()> {
    if apply_in_txn(&index, generation, &notes)? {
        emit_index_written(&app);
    }
    Ok(())
}

/// Remove a note (e.g. deleted on disk) from the index (no-op if stale).
/// This is the *genuine deletion* entry point, so embedding rows go too —
/// `apply_note`'s internal remove must NOT do this (it runs on every upsert
/// and would destroy the chunk hash-skip).
#[tauri::command]
pub fn index_remove<R: tauri::Runtime>(
    path: String,
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
) -> AppResult<()> {
    {
        let mut state = lock_state(&index)?;
        if state.generation != generation {
            return Ok(());
        }
        let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
        // One transaction: a half-removed note (row gone, chunks left) would let
        // a later note at the same path surface stale chunk text in semantic
        // search until a re-embed.
        let tx = conn.transaction()?;
        write::remove_note(&tx, &path)?;
        embed_write::remove_chunks(&tx, &path)?;
        tx.commit()?;
    }
    emit_index_written(&app);
    Ok(())
}

/// Move a note file **and** its projection in one step (Plan 17): the index
/// rows migrate and **commit first**, then the file renames; a failed rename
/// compensates with a reverse row-move. DB-first ordering is what makes the
/// watcher's echo benign by construction: `remove(from)` finds no rows, and
/// `upsert(to)` re-applies an identical projection over the moved one —
/// embedding chunks live outside `apply_note`, so vectors survive the echo.
///
/// Failure shape: every path converges. A failed commit touches nothing; a
/// failed rename compensates the rows back; and if even the compensation
/// fails, the projection is rebuildable and the id-based reconcile re-pairs
/// the row with the file wherever it actually lives (healing flow:
/// `docs/readable-filenames.md`). The rename must never
/// run *inside* the transaction — a commit failing after the file moved
/// would roll the rows back while the disk kept the new path.
///
/// `generation` is the **graph** generation (the same gate as `note_write`):
/// a rename is user-initiated file mutation, and a stale UI must be rejected
/// loudly. The index connection is whatever is current — the two states rebind
/// together on graph open, and the projection is rebuildable in the worst case.
///
/// The rename pipeline end-to-end: `docs/readable-filenames.md`.
#[tauri::command]
pub fn note_move_indexed<R: tauri::Runtime>(
    from: String,
    to: String,
    generation: u64,
    app: tauri::AppHandle<R>,
    graph: State<GraphState>,
    index: State<IndexState>,
) -> AppResult<()> {
    let root = crate::fs::root_for_generation(&graph, generation)?;
    {
        let mut state = lock_state(&index)?;
        let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
        move_rows(conn, &from, &to)?;
        if let Err(err) = crate::fs::move_note_file(&root, &from, &to) {
            // Compensate: the disk refused, so the rows go back. Best-effort —
            // a failed compensation must surface the *original* error, and the
            // reconcile heals any residue by id.
            if let Err(comp) = move_rows(conn, &to, &from) {
                tracing::error!(
                    ?comp,
                    "rename compensation failed; reconcile will heal by id"
                );
            }
            return Err(err);
        }
    }
    emit_index_written(&app);
    emit_note_moved(&app, &from, &to);
    Ok(())
}

/// One committed row-move transaction (the rename pipeline's halves).
fn move_rows(conn: &mut Connection, from: &str, to: &str) -> AppResult<()> {
    let tx = conn.transaction()?;
    // Child tables FK `notes(path)`; deferring lets the parent key move first
    // and the constraint re-check at commit, when the children have followed.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    write::move_note(&tx, from, to)?;
    tx.commit()?;
    Ok(())
}

/// Move a note's projection rows **only** (the id-based reconcile, Plan 17):
/// the file already lives at `to` — an external rename observed after the
/// fact, paired to its old row by frontmatter `id`. The rows move rather than
/// being re-created so embedding vectors survive (re-embedding identical
/// content costs the user BYOK money). No filesystem half, and unlike
/// `note_move_indexed` this is gated on the **index** generation like every
/// other reconcile-path write — a superseded pass must no-op.
#[tauri::command]
pub fn index_move<R: tauri::Runtime>(
    from: String,
    to: String,
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
) -> AppResult<()> {
    {
        let mut state = lock_state(&index)?;
        if state.generation != generation {
            return Ok(());
        }
        let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
        move_rows(conn, &from, &to)?;
    }
    emit_index_written(&app);
    emit_note_moved(&app, &from, &to);
    Ok(())
}

/// Compute the open-path reconcile delta natively (see [`scan`]): list the
/// graph's notes, compare against the stored rows, and return only what
/// needs work. The listing happens **before** the index lock is taken, so
/// thousands of stats never block concurrent reads. A stale generation
/// returns the empty scan — that pass is superseded and its writes would be
/// dropped anyway, so "nothing to do" is the honest answer.
#[tauri::command]
pub fn index_reconcile_scan(
    generation: u64,
    graph: State<GraphState>,
    index: State<IndexState>,
) -> AppResult<scan::ReconcileScan> {
    let root = crate::fs::current_root(&graph)?;
    let files = crate::fs::note_files(&root)?;
    let state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(scan::ReconcileScan::empty());
    }
    let conn = state.conn.as_ref().ok_or_else(AppError::no_graph)?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0);
    scan::scan_reconcile(conn, &files, now_ms)
}

/// One `index_touch` entry: re-stamp `path`'s stored mtime to `mtime`
/// (epoch ms, as listed by `list_files`).
#[derive(Debug, serde::Deserialize)]
pub struct IndexTouch {
    path: String,
    mtime: i64,
}

/// Re-stamp stored mtimes for notes whose content already matches disk (the
/// reconcile's hash-match skip, no-op if stale). Rows written from a local
/// write echo carry an echo-time stamp that never equals the listed on-disk
/// mtime, so without this repair those files are re-read and re-hashed on
/// every pass forever. One transaction for the batch; a path whose row
/// vanished in between updates nothing.
#[tauri::command]
pub fn index_touch(
    entries: Vec<IndexTouch>,
    generation: u64,
    index: State<IndexState>,
) -> AppResult<()> {
    let mut state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
    let tx = conn.transaction()?;
    for entry in &entries {
        write::touch_note(&tx, &entry.path, entry.mtime)?;
    }
    tx.commit()?;
    Ok(())
}

/// Upsert one `index_meta` key (no-op if stale). The table is bookkeeping the
/// TS policy layer owns — e.g. `syncIndex` stamps the projection version after
/// a rebuild — and `index_clear` deliberately preserves it, so a marker can
/// outlive the rows it describes. Reads go through the ordinary `db_query`.
#[tauri::command]
pub fn index_meta_set(
    key: String,
    value: String,
    generation: u64,
    index: State<IndexState>,
) -> AppResult<()> {
    let state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_ref().ok_or_else(AppError::no_graph)?;
    conn.prepare_cached(
        "INSERT INTO index_meta(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )?
    .execute(params![key, value])?;
    Ok(())
}

/// Wipe all derived tables (the TS layer then re-applies every note; no-op if
/// stale). The `chat_*` tables are deliberately untouched — chat history is
/// durable, not a rebuildable projection.
#[tauri::command]
pub fn index_clear<R: tauri::Runtime>(
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
) -> AppResult<()> {
    {
        let state = lock_state(&index)?;
        if state.generation != generation {
            return Ok(());
        }
        let conn = state.conn.as_ref().ok_or_else(AppError::no_graph)?;
        write::clear_index(conn)?;
    }
    emit_index_written(&app);
    Ok(())
}

/// Upsert one chat message and its conversation row in a single transaction
/// (no-op if stale). Called at send time with the user half and again at
/// settle with the full record, so a crash mid-stream keeps the user message.
/// Stale-generation writes are dropped like every other index write — a turn
/// detached by a graph switch must not land in the new graph's history.
#[tauri::command]
pub fn chat_message_save(
    conversation: ChatConversation,
    message: ChatMessageRow,
    generation: u64,
    index: State<IndexState>,
) -> AppResult<()> {
    let mut state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
    let tx = conn.transaction()?;
    chat_write::save_message(&tx, &conversation, &message)?;
    tx.commit()?;
    Ok(())
}

/// Delete a conversation and (via cascade) its messages (no-op if stale).
#[tauri::command]
pub fn chat_conversation_delete(
    id: String,
    generation: u64,
    index: State<IndexState>,
) -> AppResult<()> {
    let state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_ref().ok_or_else(AppError::no_graph)?;
    chat_write::delete_conversation(conn, &id)
}

/// Replace a note's embedding chunk set (diff applied in one transaction;
/// no-op if stale). Unchanged chunks keep their vectors — the hash-skip.
#[tauri::command]
pub fn embed_apply(
    path: String,
    chunks: Vec<EmbeddedChunk>,
    generation: u64,
    index: State<IndexState>,
) -> AppResult<()> {
    let mut state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
    let tx = conn.transaction()?;
    embed_write::apply_chunks(&tx, &path, &chunks)?;
    tx.commit()?;
    Ok(())
}

/// Drop a deleted note's chunks + vectors (no-op if stale).
#[tauri::command]
pub fn embed_remove(path: String, generation: u64, index: State<IndexState>) -> AppResult<()> {
    let mut state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
    // Two DELETEs (vectors, then rows): atomic, mirroring embed_apply.
    let tx = conn.transaction()?;
    embed_write::remove_chunks(&tx, &path)?;
    tx.commit()?;
    Ok(())
}

/// Execute a read query (compiled by Kysely on the frontend) and return rows.
#[tauri::command]
pub fn db_query(
    sql: String,
    params: Vec<Value>,
    index: State<IndexState>,
) -> AppResult<Vec<Map<String, Value>>> {
    let state = lock_state(&index)?;
    let conn = state.conn.as_ref().ok_or_else(AppError::no_graph)?;
    query::run_query(conn, &sql, &params)
}
