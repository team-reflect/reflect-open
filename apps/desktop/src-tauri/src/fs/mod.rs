//! Graph file-IO primitives (Plan 02).
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative** — the graph root lives
//! in Rust state and the frontend can never address files outside it
//! (path-traversal guard, [`resolve`]). Writes are atomic (temp file + rename,
//! [`io`]) and deletes go to the OS trash. Parsing/indexing live in later plans.

mod io;
mod resolve;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};

use self::io::{atomic_write, atomic_write_bytes, bootstrap, collect_files, NOTE_DIRS};
use self::resolve::resolve;

pub(crate) use self::io::modified_ms;
/// The traversal guard, shared with sibling modules that address graph files
/// (capture promotes screenshots into `assets/`).
pub(crate) use self::resolve::resolve as resolve_in_graph;

/// The open graph root plus a monotonic generation, kept **under one lock** so
/// they swap atomically (the same pattern as the index's `IndexState`, Plan 04b).
/// Mutating commands carry the generation they were issued for and are rejected
/// when it's stale — so a write enqueued for one graph can never land in another
/// graph's same-named file after a switch swaps the root.
#[derive(Default)]
pub struct GraphInner {
    pub generation: u64,
    pub root: Option<PathBuf>,
}

/// Tauri-managed state holding the currently open graph (root + generation).
#[derive(Default)]
pub struct GraphState(pub Mutex<GraphInner>);

/// Identity of an open graph, returned to the frontend.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphInfo {
    /// Absolute path of the graph root.
    pub root: String,
    /// Display name (the root folder name).
    pub name: String,
    /// File-sync provider this graph appears to live inside (e.g. `"icloud"`),
    /// or `None`. A `Some(_)` means the UI should warn — Reflect syncs via
    /// GitHub only and a cloud-synced graph risks index corruption (Plan 12/04).
    pub cloud_sync: Option<String>,
    /// Open-session generation; mutating file commands must echo it back.
    pub generation: u64,
}

/// Metadata for a file inside the graph.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub size: u64,
    /// Last-modified time in epoch milliseconds.
    pub modified_ms: u64,
}

// ---- state accessors --------------------------------------------------------

fn graph_info(root: &Path, generation: u64) -> GraphInfo {
    let name = root
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    GraphInfo {
        root: root.to_string_lossy().into_owned(),
        name,
        cloud_sync: crate::recents::detect_cloud_sync(root).map(str::to_string),
        generation,
    }
}

/// Set the active root (bumping the generation atomically), record it in
/// recents, and return its info.
fn activate(state: &State<GraphState>, root: &Path) -> AppResult<GraphInfo> {
    let generation = {
        let mut inner = lock_graph(state)?;
        inner.generation += 1;
        inner.root = Some(root.to_path_buf());
        inner.generation
    };
    let info = graph_info(root, generation);
    // Recents is a convenience cache: a failure to persist it must not fail the
    // open (which would leave Rust treating the graph as open while the command
    // returns an error, out of sync with the UI). Best-effort, log and move on.
    if let Err(err) = crate::recents::record(root, &info.name) {
        tracing::warn!(?err, "failed to record recent graph");
    }
    Ok(info)
}

fn lock_graph<'a>(
    state: &'a State<GraphState>,
) -> AppResult<std::sync::MutexGuard<'a, GraphInner>> {
    state.0.lock().map_err(|err| {
        // A poisoned lock means a command panicked while holding it — the panic
        // itself is the bug; this context points at the blast radius.
        tracing::error!(?err, "graph state lock poisoned by an earlier panic");
        AppError::io("graph state lock poisoned")
    })
}

pub(crate) fn current_root(state: &State<GraphState>) -> AppResult<PathBuf> {
    lock_graph(state)?
        .root
        .clone()
        .ok_or_else(AppError::no_graph)
}

/// The current root, verified against the generation a mutating command was
/// issued for. A stale generation means the graph was switched after the
/// command was enqueued — the mutation must be rejected (loudly), or it would
/// land in the *new* graph's same-named file.
pub(crate) fn root_for_generation(
    state: &State<GraphState>,
    generation: u64,
) -> AppResult<PathBuf> {
    let inner = lock_graph(state)?;
    if inner.generation != generation {
        return Err(AppError::io(
            "the graph changed since this command was issued; dropping it",
        ));
    }
    inner.root.clone().ok_or_else(AppError::no_graph)
}

/// `current_root`, or `root_for_generation` when the caller pinned the
/// command. Read commands take an optional pin: UI reads for the open graph
/// omit it, background passes (audio-memo reconcile) that can span a graph
/// switch must supply it so every step of a pass sees one graph.
fn root_for(state: &State<GraphState>, generation: Option<u64>) -> AppResult<PathBuf> {
    match generation {
        Some(generation) => root_for_generation(state, generation),
        None => current_root(state),
    }
}

// ---- commands --------------------------------------------------------------

/// Let the asset protocol serve files from the graph (image rendering, Plan 05).
/// Best-effort: a failure means images don't render, never that the open fails.
fn allow_asset_scope(app: &tauri::AppHandle, root: &Path) {
    use tauri::Manager;
    if let Err(err) = app.asset_protocol_scope().allow_directory(root, true) {
        tracing::warn!(%err, "failed to extend the asset scope");
    }
}

/// Create a new graph at `path` (scaffolds the layout) and open it.
#[tauri::command]
pub fn graph_create(
    path: String,
    app: tauri::AppHandle,
    state: State<GraphState>,
) -> AppResult<GraphInfo> {
    let root = PathBuf::from(&path);
    fs::create_dir_all(&root)?;
    bootstrap(&root)?;
    let info = activate(&state, &root)?;
    allow_asset_scope(&app, &root);
    Ok(info)
}

/// Open an existing graph at `path`, ensuring the standard layout exists.
#[tauri::command]
pub fn graph_open(
    path: String,
    app: tauri::AppHandle,
    state: State<GraphState>,
) -> AppResult<GraphInfo> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::not_found(format!("not a directory: {path}")));
    }
    bootstrap(&root)?;
    let info = activate(&state, &root)?;
    allow_asset_scope(&app, &root);
    Ok(info)
}

/// Read a note's markdown by graph-relative path. `generation`, when given,
/// pins the read to the issuing graph session (see [`root_for`]).
#[tauri::command]
pub fn note_read(
    path: String,
    generation: Option<u64>,
    state: State<GraphState>,
) -> AppResult<String> {
    let root = root_for(&state, generation)?;
    Ok(fs::read_to_string(resolve(&root, &path)?)?)
}

/// Atomically write a note's markdown by graph-relative path. `generation` pins
/// the write to the graph it was issued for (see `root_for_generation`).
#[tauri::command]
pub fn note_write(
    path: String,
    contents: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    let root = root_for_generation(&state, generation)?;
    atomic_write(&resolve(&root, &path)?, &contents)
}

/// Atomically write a binary asset (pasted/dropped image) by graph-relative
/// path. Contents arrive base64-encoded — Tauri IPC args are JSON, and pasted
/// images are small enough that the ~33% encoding overhead is irrelevant.
#[tauri::command]
pub fn asset_write(
    path: String,
    contents_base64: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    use base64::Engine;
    let root = root_for_generation(&state, generation)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|err| AppError::io(format!("invalid base64 asset payload: {err}")))?;
    atomic_write_bytes(&resolve(&root, &path)?, &bytes)
}

/// Read a binary asset's bytes, base64-encoded for the JSON IPC (e.g. audio
/// memos read back for transcription). Pinned to `generation`, unlike
/// `note_read`: the caller is a background pass that can span a graph
/// switch, and an unpinned read would resolve against the *new* root —
/// handing back (and possibly sending to a provider) another graph's file.
#[tauri::command]
pub fn asset_read(path: String, generation: u64, state: State<GraphState>) -> AppResult<String> {
    use base64::Engine;
    let root = root_for_generation(&state, generation)?;
    let bytes = fs::read(resolve(&root, &path)?)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// List every file (any extension) under a graph-relative directory, e.g.
/// `audio-memos`. Which directory means what is the TypeScript layer's policy;
/// a missing directory lists as empty. Pinned to `generation` for the same
/// reason as `asset_read` — the listing seeds a background pass that must
/// never mix graphs.
#[tauri::command]
pub fn dir_list(
    dir: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<Vec<FileMeta>> {
    let root = root_for_generation(&state, generation)?;
    resolve(&root, &dir)?; // traversal guard; the walk itself skips symlinks
    let mut out = Vec::new();
    collect_files(&root, &dir, None, &mut out)?;
    Ok(out)
}

/// Does a graph-relative path currently exist as a file? The collision picker
/// (Plan 17) probes disk as well as the index — the index lags the watcher by
/// a debounce, and an unindexed file must never be clobbered by a new note.
#[tauri::command]
pub fn note_exists(path: String, state: State<GraphState>) -> AppResult<bool> {
    let root = current_root(&state)?;
    Ok(resolve(&root, &path)?.is_file())
}

/// Rename `from` → `to` on disk (both graph-relative, traversal-guarded).
///
/// An occupied destination refuses (loudly), matching the projection half
/// (`db::write::move_note`): the collision probe raced something — nothing is
/// deleted or overwritten, the caller compensates, and the rename simply
/// reports failed. One rule, no adoption heuristics; the filename drifts
/// until the next settled rename retries.
pub(crate) fn move_note_file(root: &Path, from: &str, to: &str) -> AppResult<()> {
    let from_abs = resolve(root, from)?;
    let to_abs = resolve(root, to)?;
    if to_abs.is_file() {
        return Err(AppError::io(format!(
            "cannot move note: {to} already exists on disk"
        )));
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(from_abs, to_abs)?;
    Ok(())
}

/// Send a note to the OS trash (recoverable), not a hard delete (pinned to
/// `generation`).
#[tauri::command]
pub fn note_delete(path: String, generation: u64, state: State<GraphState>) -> AppResult<()> {
    let root = root_for_generation(&state, generation)?;
    trash::delete(resolve(&root, &path)?).map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

/// List markdown notes under `daily/` and `notes/`. `generation`, when given,
/// pins the listing to the issuing graph session (see [`root_for`]).
#[tauri::command]
pub fn list_files(generation: Option<u64>, state: State<GraphState>) -> AppResult<Vec<FileMeta>> {
    let root = root_for(&state, generation)?;
    let mut out = Vec::new();
    for dir in NOTE_DIRS {
        collect_files(&root, dir, Some("md"), &mut out)?;
    }
    Ok(out)
}

#[cfg(test)]
mod move_tests {
    use super::move_note_file;
    use std::fs;

    fn graph() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        dir
    }

    #[test]
    fn renames_when_the_destination_is_free() {
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# A\n").unwrap();
        move_note_file(root.path(), "notes/a.md", "notes/b.md").unwrap();
        assert!(!root.path().join("notes/a.md").exists());
        assert_eq!(
            fs::read_to_string(root.path().join("notes/b.md")).unwrap(),
            "# A\n"
        );
    }

    #[test]
    fn an_occupied_destination_refuses_with_both_files_intact() {
        // Whatever appeared at the destination after the collision probe,
        // nothing is deleted or overwritten — the rename just fails.
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();
        fs::write(root.path().join("notes/b.md"), "# Theirs\n").unwrap();
        assert!(move_note_file(root.path(), "notes/a.md", "notes/b.md").is_err());
        assert_eq!(
            fs::read_to_string(root.path().join("notes/a.md")).unwrap(),
            "# Mine\n"
        );
        assert_eq!(
            fs::read_to_string(root.path().join("notes/b.md")).unwrap(),
            "# Theirs\n"
        );
    }
}
