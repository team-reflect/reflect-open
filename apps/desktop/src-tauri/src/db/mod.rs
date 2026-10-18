//! The SQLite index commands (Plan 04): thin Tauri wrappers over
//! [`reflect_index::IndexSession`].
//!
//! The session owns the connections, the generation gate and every
//! transaction. This module decides what is Tauri's: the managed state, the
//! iOS background assertion a write holds before it takes the SQLite lock,
//! the thread a command runs on, and the `index:written` / `note:moved`
//! broadcasts after a committed write.

use std::path::PathBuf;

use reflect_index::{Applied, FileIndexConnections};
use serde_json::{Map, Value};
use tauri::{Manager, State};

use crate::background_task::{self, BackgroundTaskState};
use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

pub use reflect_index::{
    ChatConversation, ChatMessageRow, EmbeddedChunk, IndexSession as IndexState, IndexTouch,
    IndexedNote, MovedNoteAddress, NoteMoveRequest, ReconcileScan,
};

/// The open index session's generation as a pure read, or `None` when no
/// index is open. The note-window bootstrap (`windows::window_bootstrap`)
/// adopts the session through this.
pub(crate) fn current_generation(index: &IndexState) -> AppResult<Option<u64>> {
    index.current_generation()
}

fn emit_index_written<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    use tauri::Emitter;
    let _ = app.emit(reflect_types::events::INDEX_WRITTEN, ());
}

fn emit_note_moved<R: tauri::Runtime>(app: &tauri::AppHandle<R>, from: &str, to: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        reflect_types::events::NOTE_MOVED,
        serde_json::json!({ "from": from, "to": to }),
    );
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

// ---- commands --------------------------------------------------------------

/// Open + migrate the index for the active graph (reads the root from state).
/// Returns the new generation, which write commands must echo back.
#[tauri::command]
pub fn index_open(
    graph: State<GraphState>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<u64> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index open");
    let root: PathBuf = graph
        .0
        .lock()
        .map_err(|err| {
            tracing::error!(?err, "graph state lock poisoned by an earlier panic");
            AppError::io("graph state lock poisoned")
        })?
        .root
        .clone()
        .ok_or_else(AppError::no_graph)?;
    index.open(&root, &FileIndexConnections)
}

/// Apply one note's extracted projection in a single transaction (no-op if
/// the generation is stale).
#[tauri::command]
pub fn index_apply<R: tauri::Runtime>(
    note: IndexedNote,
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index update");
    if index.apply(generation, std::slice::from_ref(&note))? == Applied::Committed {
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
    let _background_task = background_task::scoped(&background_tasks, "Reflect index update");
    if index.apply(generation, &notes)? == Applied::Committed {
        emit_index_written(&app);
    }
    Ok(())
}

/// Remove a note (e.g. deleted on disk) from the index, embedding rows
/// included (no-op if stale).
#[tauri::command]
pub fn index_remove<R: tauri::Runtime>(
    path: String,
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index remove");
    if index.remove(generation, &path)? == Applied::Committed {
        emit_index_written(&app);
    }
    Ok(())
}

/// Move a note file **and** its projection in one step (Plan 17). `generation`
/// is the **graph** generation (the same gate as `note_write`): a rename is
/// user-initiated file mutation, and a stale UI must be rejected loudly. The
/// rename pipeline end-to-end: `docs/readable-filenames.md`.
#[tauri::command(async)]
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
    crate::fs::with_graph_lock(&root, || {
        crate::fs::root_for_generation(&graph, generation)?;
        index.move_note(&root, &request, || {
            crate::fs::move_note_file(&root, &request.from, &request.to)
        })
    })?;
    crate::fs::invalidate_file_catalog(&graph, &root);
    emit_index_written(&app);
    emit_note_moved(&app, &request.from, &request.to);
    Ok(())
}

/// Move a note's projection rows **only** (the id-based reconcile, Plan 17);
/// no-op if the index generation is stale.
#[tauri::command]
pub fn index_move<R: tauri::Runtime>(
    from: String,
    to: String,
    generation: u64,
    to_address: MovedNoteAddress,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index move");
    if index.move_rows(generation, &from, &to, &to_address)? == Applied::Committed {
        emit_index_written(&app);
        emit_note_moved(&app, &from, &to);
    }
    Ok(())
}

/// Compute the open-path reconcile delta natively: list the graph's notes,
/// compare against the stored rows, and return only what needs work. The walk
/// runs **without** the index lock held, so thousands of stats never block
/// concurrent reads. A stale generation returns the empty scan.
#[tauri::command]
pub async fn index_reconcile_scan<R: tauri::Runtime>(
    generation: u64,
    app: tauri::AppHandle<R>,
) -> AppResult<ReconcileScan> {
    // Async on purpose: this is one uninterruptible O(graph) walk + table
    // read, and as a sync command it occupied the iOS main thread — the
    // post-paint "I can see a note but can't tap it" freeze on every open.
    crate::blocking::run_blocking(move || {
        let started = std::time::Instant::now();
        let index = app.state::<IndexState>();
        let Some(root) = index.root_for_generation(generation)? else {
            return Ok(ReconcileScan::empty());
        };
        let walk_started = std::time::Instant::now();
        let files = crate::fs::note_files(&root);
        let walk_ms = walk_started.elapsed().as_millis() as u64;
        let scan = index.reconcile_scan(generation, &files, now_ms())?;
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

/// Re-stamp stored mtimes for notes whose content already matches disk (the
/// reconcile's hash-match skip, no-op if stale).
#[tauri::command]
pub fn index_touch(
    entries: Vec<IndexTouch>,
    generation: u64,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index touch");
    index.touch(generation, &entries).map(drop)
}

/// Upsert one `index_meta` key (no-op if stale). Reads go through `db_query`.
#[tauri::command]
pub fn index_meta_set(
    key: String,
    value: String,
    generation: u64,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index metadata");
    index.set_meta(generation, &key, &value).map(drop)
}

/// Wipe all derived tables (the TS layer then re-applies every note; no-op if
/// stale). Chat history is untouched.
#[tauri::command]
pub fn index_clear<R: tauri::Runtime>(
    generation: u64,
    app: tauri::AppHandle<R>,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect index clear");
    if index.clear(generation)? == Applied::Committed {
        emit_index_written(&app);
    }
    Ok(())
}

/// Upsert one chat message and its conversation row (no-op if stale). A turn
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
    index
        .save_chat_message(generation, &conversation, &message)
        .map(drop)
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
    index.delete_chat_conversation(generation, &id).map(drop)
}

/// Replace a note's embedding chunk set (no-op if stale).
#[tauri::command]
pub fn embed_apply(
    path: String,
    chunks: Vec<EmbeddedChunk>,
    generation: u64,
    index: State<IndexState>,
    background_tasks: State<BackgroundTaskState>,
) -> AppResult<()> {
    let _background_task = background_task::scoped(&background_tasks, "Reflect embeddings update");
    index.apply_embeddings(generation, &path, &chunks).map(drop)
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
    index.remove_embeddings(generation, &path).map(drop)
}

/// Execute a read query (compiled by Kysely on the frontend) and return rows.
///
/// Async on purpose: sync commands run on the main thread, which on iOS also
/// owns touch delivery — a long FTS scan there reads as a frozen app. Runs on
/// the session's read-only connection so it never holds the writer lock a
/// sync write command would block the main thread waiting for.
#[tauri::command]
pub async fn db_query<R: tauri::Runtime>(
    sql: String,
    params: Vec<Value>,
    app: tauri::AppHandle<R>,
) -> AppResult<Vec<Map<String, Value>>> {
    // Pin the index session before the hop: with no main-thread FIFO, a
    // graph switch can rebind the index between invoke and execution, and a
    // query issued for graph A must not return graph B's rows.
    let requested = app.state::<IndexState>().read_generation()?;
    crate::blocking::run_blocking(move || app.state::<IndexState>().query(requested, &sql, &params))
        .await
}
