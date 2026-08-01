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
use tauri::{Manager, State};

use crate::background_task::{self, BackgroundTaskState};
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
#[derive(Default)]
struct IndexInner {
    generation: u64,
    conn: Option<Connection>,
    /// The graph root this generation's index was opened for. Reconcile
    /// scans list *this* root, never the graph state's current one: with
    /// async commands there is no main-thread FIFO ordering scans against
    /// `graph_open`, so a queued scan could otherwise walk a freshly-swapped
    /// root and diff another graph's files against this index — in the
    /// window before the switch's `index_open` bumps the generation, that
    /// delta would pass the staleness gate and drive cross-graph writes.
    root: Option<std::path::PathBuf>,
}

/// The `db_query` reader: a second, **read-only** connection under its own
/// lock. Queries run on the blocking pool now, and the write commands are
/// still synchronous main-thread calls — if both shared one mutex, a long
/// FTS scan holding it would make the next `index_apply`/`index_touch` block
/// the iOS main thread for the read's duration, recreating the exact
/// touch-delivery stall the async conversion removed. Under WAL the reader
/// sees the last committed state, so a query after an awaited write still
/// reads its result; it just never contends with one. Rebound (with its own
/// generation copy, so the pair swaps atomically for readers of *this* lock)
/// by `index_open` while the writer lock is held — lock order is always
/// writer → reader, nothing locks the reverse way.
#[derive(Default)]
struct ReadInner {
    generation: u64,
    conn: Option<Connection>,
}

/// The active graph's index state (`conn`s are `None` until `index_open`).
#[derive(Default)]
pub struct IndexState {
    inner: Mutex<IndexInner>,
    read: Mutex<ReadInner>,
}

fn lock_state<'a>(index: &'a State<IndexState>) -> AppResult<MutexGuard<'a, IndexInner>> {
    index.inner.lock().map_err(|err| {
        // A poisoned lock means a command panicked while holding it — the panic
        // itself is the bug; this context points at the blast radius.
        tracing::error!(?err, "index state lock poisoned by an earlier panic");
        AppError::io("index state lock poisoned")
    })
}

fn lock_read<'a>(index: &'a State<IndexState>) -> AppResult<MutexGuard<'a, ReadInner>> {
    index.read.lock().map_err(|err| {
        tracing::error!(?err, "index read lock poisoned by an earlier panic");
        AppError::io("index read lock poisoned")
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
pub fn index_open(
    graph: State<GraphState>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<u64> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index open");
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
    // Drop the old connections before opening; if an open fails we return
    // with `conn = None` (reads then error) rather than a stale connection.
    // The root is rebound with the writer, under the same lock, so a
    // generation can never pair with another graph's root (see
    // `IndexInner::root`). The reader rebinds while the writer lock is still
    // held (writer → reader lock order), after the writer created/migrated
    // the file it opens read-only.
    state.conn = None;
    state.root = None;
    {
        let mut read = lock_read(&index)?;
        read.conn = None;
    }
    state.conn = Some(migrations::open_index_at(&root)?);
    let mut read = lock_read(&index)?;
    read.conn = Some(migrations::open_index_read_only_at(&root)?);
    read.generation = state.generation;
    state.root = Some(root);
    Ok(state.generation)
}

/// Apply a batch of note projections in a single transaction (shared by the
/// one-note and batch commands). No-op if the generation is stale — a superseded
/// pass must not write the new graph's index. One transaction + cached statements
/// keeps a full rebuild cheap; an empty batch commits a no-op transaction.
/// Returns whether it committed, so callers only broadcast real writes.
fn apply_in_txn(
    index: &State<IndexState>,
    background_tasks: &State<BackgroundTaskState>,
    generation: u64,
    notes: &[IndexedNote],
) -> AppResult<bool> {
    let _background_task = background_task::scoped(background_tasks, "Reflect index update");
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    if apply_in_txn(
        &index,
        &background_tasks,
        generation,
        std::slice::from_ref(&note),
    )? {
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    if apply_in_txn(&index, &background_tasks, generation, &notes)? {
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index remove");
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
/// One user-initiated move, with the folded addressing for both directions:
/// the destination's for the forward row move, the source's for the
/// compensating reverse move when the disk refuses.
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMoveRequest {
    from: String,
    to: String,
    to_address: write::MovedNoteAddress,
    from_address: write::MovedNoteAddress,
}

#[tauri::command]
pub fn note_move_indexed<R: tauri::Runtime>(
    request: NoteMoveRequest,
    generation: u64,
    app: tauri::AppHandle<R>,
    graph: State<GraphState>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect note move");
    let root = crate::fs::root_for_generation(&graph, generation)?;
    {
        let mut state = lock_state(&index)?;
        let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
        move_rows(conn, &request.from, &request.to, &request.to_address)?;
        if let Err(err) = crate::fs::move_note_file(&root, &request.from, &request.to) {
            // Compensate: the disk refused, so the rows go back. Best-effort —
            // a failed compensation must surface the *original* error, and the
            // reconcile heals any residue by id.
            if let Err(comp) = move_rows(conn, &request.to, &request.from, &request.from_address) {
                tracing::error!(
                    ?comp,
                    "rename compensation failed; reconcile will heal by id"
                );
            }
            return Err(err);
        }
    }
    crate::fs::invalidate_file_catalog(&graph, &root);
    emit_index_written(&app);
    emit_note_moved(&app, &request.from, &request.to);
    Ok(())
}

/// One committed row-move transaction (the rename pipeline's halves).
fn move_rows(
    conn: &mut Connection,
    from: &str,
    to: &str,
    address: &write::MovedNoteAddress,
) -> AppResult<()> {
    let tx = conn.transaction()?;
    // Child tables FK `notes(path)`; deferring lets the parent key move first
    // and the constraint re-check at commit, when the children have followed.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
    write::move_note(&tx, from, to, address)?;
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
    to_address: write::MovedNoteAddress,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index move");
    {
        let mut state = lock_state(&index)?;
        if state.generation != generation {
            return Ok(());
        }
        let conn = state.conn.as_mut().ok_or_else(AppError::no_graph)?;
        move_rows(conn, &from, &to, &to_address)?;
    }
    emit_index_written(&app);
    emit_note_moved(&app, &from, &to);
    Ok(())
}

/// Compute the open-path reconcile delta natively (see [`scan`]): list the
/// graph's notes, compare against the stored rows, and return only what
/// needs work. The walk runs **without** the index lock held, so thousands
/// of stats never block concurrent reads; the generation is checked again
/// after it, so a graph switch mid-walk yields the empty scan. A stale
/// generation returns the empty scan — that pass is superseded and its
/// writes would be dropped anyway, so "nothing to do" is the honest answer.
#[tauri::command]
pub async fn index_reconcile_scan<R: tauri::Runtime>(
    generation: u64,
    app: tauri::AppHandle<R>,
) -> AppResult<scan::ReconcileScan> {
    // Async on purpose: this is one uninterruptible O(graph) walk + table
    // read, and as a sync command it occupied the iOS main thread — the
    // post-paint "I can see a note but can't tap it" freeze on every open.
    crate::blocking::run_blocking(move || {
        let started = std::time::Instant::now();
        let index = app.state::<IndexState>();
        // The root comes from the index session, not the graph state: async
        // commands have no ordering against `graph_open`, and listing a
        // just-swapped root against this generation's rows would diff two
        // different graphs (see `IndexInner::root`).
        let root = {
            let state = lock_state(&index)?;
            if state.generation != generation {
                return Ok(scan::ReconcileScan::empty());
            }
            state.root.clone().ok_or_else(AppError::no_graph)?
        };
        let walk_started = std::time::Instant::now();
        let files = crate::fs::note_files(&root);
        let walk_ms = walk_started.elapsed().as_millis() as u64;
        let state = lock_state(&index)?;
        if state.generation != generation {
            return Ok(scan::ReconcileScan::empty());
        }
        let conn = state.conn.as_ref().ok_or_else(AppError::no_graph)?;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_millis() as u64)
            .unwrap_or(0);
        let scan = scan::scan_reconcile(conn, &files, now_ms)?;
        tracing::info!(
            files = scan.total,
            candidates = scan.candidates.len(),
            orphans = scan.orphans.len(),
            walk_ms,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "index_reconcile_scan"
        );
        Ok(scan)
    })
    .await
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index touch");
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index metadata");
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index clear");
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect chat save");
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect chat delete");
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
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect embeddings update");
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
pub fn embed_remove(
    path: String,
    generation: u64,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect embeddings remove");
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
///
/// Async on purpose: sync commands run on the main thread, which on iOS also
/// owns touch delivery — a long FTS scan there reads as a frozen app. Runs
/// on the dedicated read-only connection ([`ReadInner`]) so it never holds
/// the writer lock a sync write command would block the main thread waiting
/// for.
#[tauri::command]
pub async fn db_query<R: tauri::Runtime>(
    sql: String,
    params: Vec<Value>,
    app: tauri::AppHandle<R>,
) -> AppResult<Vec<Map<String, Value>>> {
    // Pin the index session before the hop: with no main-thread FIFO, a
    // graph switch can rebind the index between invoke and execution, and a
    // query issued for graph A must not return graph B's rows — the frontend
    // caches results under root-scoped keys with `staleTime: Infinity`, so
    // one crossed response would be served as fresh forever. An erroring
    // superseded query is honest instead: its observers unmounted with the
    // switch, so nothing retries it against the wrong graph.
    let requested = {
        let index = app.state::<IndexState>();
        let generation = lock_read(&index)?.generation;
        generation
    };
    crate::blocking::run_blocking(move || {
        let index = app.state::<IndexState>();
        let read = lock_read(&index)?;
        if read.generation != requested {
            return Err(AppError::io("index reopened during query"));
        }
        let conn = read.conn.as_ref().ok_or_else(AppError::no_graph)?;
        query::run_query(conn, &sql, &params)
    })
    .await
}
