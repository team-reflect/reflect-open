//! SQLite index layer (Plan 04).
//!
//! The graph's rebuildable projection lives at `<graph>/.reflect/index.sqlite`,
//! backed by the bundled SQLite (FTS5 compiled in) with sqlite-vec registered for
//! Plan 09. Parsing/extraction happens in TS (`@reflect/core`, Plan 03); this
//! module owns the schema/migrations ([`migrations`]), all writes — one
//! transaction per batch, generation-gated here in the command layer
//! ([`write`] holds the row logic) — plus a read-only `db_query` bridge
//! ([`query`]) that executes the SQL the frontend builds with Kysely. The DB is
//! a cache: deleting it loses nothing durable.

mod embed_write;
mod migrations;
mod query;
#[cfg(test)]
mod tests;
mod write;

use std::sync::{Mutex, MutexGuard};

use rusqlite::{params, Connection};
use serde_json::{Map, Value};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

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
fn apply_in_txn(
    index: &State<IndexState>,
    generation: u64,
    notes: &[IndexedNote],
) -> AppResult<()> {
    let mut state = lock_state(index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
    let tx = conn.transaction()?;
    for note in notes {
        write::apply_note(&tx, note)?;
    }
    tx.commit()?;
    Ok(())
}

/// Apply one note's extracted projection in a single transaction.
#[tauri::command]
pub fn index_apply(note: IndexedNote, generation: u64, index: State<IndexState>) -> AppResult<()> {
    apply_in_txn(&index, generation, std::slice::from_ref(&note))
}

/// Apply many notes' projections in one transaction (the full-rebuild path).
#[tauri::command]
pub fn index_apply_batch(
    notes: Vec<IndexedNote>,
    generation: u64,
    index: State<IndexState>,
) -> AppResult<()> {
    apply_in_txn(&index, generation, &notes)
}

/// Remove a note (e.g. deleted on disk) from the index (no-op if stale).
/// This is the *genuine deletion* entry point, so embedding rows go too —
/// `apply_note`'s internal remove must NOT do this (it runs on every upsert
/// and would destroy the chunk hash-skip).
#[tauri::command]
pub fn index_remove(path: String, generation: u64, index: State<IndexState>) -> AppResult<()> {
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
pub fn note_move_indexed(
    from: String,
    to: String,
    generation: u64,
    graph: State<GraphState>,
    index: State<IndexState>,
) -> AppResult<()> {
    let root = crate::fs::root_for_generation(&graph, generation)?;
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
pub fn index_move(
    from: String,
    to: String,
    generation: u64,
    index: State<IndexState>,
) -> AppResult<()> {
    let mut state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
    move_rows(conn, &from, &to)
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

/// Wipe all derived tables (the TS layer then re-applies every note; no-op if stale).
#[tauri::command]
pub fn index_clear(generation: u64, index: State<IndexState>) -> AppResult<()> {
    let state = lock_state(&index)?;
    if state.generation != generation {
        return Ok(());
    }
    let conn = state.conn.as_ref().ok_or_else(AppError::no_graph)?;
    write::clear_index(conn)
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
