//! Graph file-IO primitives (Plan 02).
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative** — the graph root lives
//! in Rust state and the frontend can never address files outside it
//! (path-traversal guard, [`resolve`]). Writes are atomic (temp file + rename,
//! [`io`]) and deletes go to the OS trash. Parsing/indexing live in later plans.

pub mod asset_protocol;
pub mod assets;
mod import;
mod import_assets;
mod io;
mod resolve;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};

use self::io::{atomic_write, bootstrap, collect_files, NOTE_DIRS};
use self::resolve::resolve;

/// Cancellation flag for the running Reflect V1 import, managed as Tauri
/// state in `lib.rs` (`graph_import_cancel` trips it).
pub use self::import::ImportCancel;

/// Atomic byte write staged under `.reflect/tmp/`, shared with the conflict
/// machinery (shadow bases, resolution writes) so every graph write follows
/// the same crash-safe, sync-clean path.
pub(crate) use self::io::atomic_write_bytes;

/// iCloud eviction-placeholder name mapping, shared with the watcher (which
/// must treat an evicted note as present, not deleted — Plan 21). Desktop-only
/// like the watcher itself; mobile's change source is the Plan 21 Phase 2
/// metadata query, which maps placeholders on its own side.
#[cfg(desktop)]
pub(crate) use self::io::eviction_placeholder;
/// "Occupied" probe (real file OR eviction placeholder), shared with the
/// iCloud sweep's collision folding — an evicted canonical note must not be
/// treated as a free slot (Plan 21).
pub(crate) use self::io::file_occupied;
/// The one home of the `.{name}.icloud` placeholder grammar, shared with the
/// desktop watcher and the iCloud container discovery (`icloud::storage`).
pub(crate) use self::io::icloud_placeholder_target;
/// Sync-exclusion marking, shared with `git::repo` (a freshly initialized
/// backup repo must never ride a file-sync provider — Plan 21).
pub(crate) use self::io::mark_dir_local_only;
pub(crate) use self::io::modified_ms;
/// The lexical traversal guard, shared with the conflict stores that mirror
/// note paths under `.reflect/` (shadow bases, conflict archive).
pub(crate) use self::resolve::ensure_relative;
/// The full traversal guard, shared with sibling modules that address graph
/// files (capture promotes screenshots into `assets/`).
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
    /// True when the file is an iCloud eviction placeholder: the note exists
    /// but its content is not on disk until re-downloaded. Consumers must not
    /// read it — and must not treat it as deleted (Plan 21). `size` and
    /// `modified_ms` describe the placeholder stub, not the real file.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub placeholder: bool,
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

/// The open graph's identity as a pure read — the note-window bootstrap
/// (`windows::window_bootstrap`) must *adopt* the session, never re-open it:
/// a generation bump here would strand every command the main window has
/// pinned to the current one.
pub(crate) fn current_graph_info(state: &State<GraphState>) -> AppResult<GraphInfo> {
    let inner = lock_graph(state)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok(graph_info(&root, inner.generation))
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

fn ensure_asset_path(path: &str) -> AppResult<()> {
    if path
        .strip_prefix("assets/")
        .is_some_and(|rest| !rest.is_empty())
    {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "asset path must be under assets/: {path}"
    )))
}

// ---- commands --------------------------------------------------------------

/// Create a new graph at `path` (scaffolds the layout) and open it.
#[tauri::command]
pub fn graph_create(path: String, state: State<GraphState>) -> AppResult<GraphInfo> {
    let root = PathBuf::from(&path);
    fs::create_dir_all(&root)?;
    bootstrap(&root)?;
    activate(&state, &root)
}

/// Import a user-selected Reflect V1 export `.zip` into the open graph. V1's
/// export is already the graph folder shape, so this extracts safe entries
/// directly under the current root; existing files are never replaced (and
/// never fail the import — identical files skip, conflicting notes rename,
/// conflicting daily notes merge). Attachments the notes link to on Firebase
/// Storage are downloaded into `assets/` first and the links rewritten, so
/// the imported graph doesn't depend on Reflect V1's infrastructure staying
/// up. Progress is emitted as `import:progress` events, and
/// [`graph_import_cancel`] aborts the run before anything lands in the graph.
#[tauri::command]
pub async fn graph_import_reflect_v1_zip(
    path: String,
    generation: u64,
    app: tauri::AppHandle,
    state: State<'_, GraphState>,
    cancel: State<'_, ImportCancel>,
) -> AppResult<import::ImportSummary> {
    let root = root_for_generation(&state, generation)?;
    // Holds the one import slot until this command returns on any path — a
    // second import starting mid-run would clear a cancel meant for the
    // first and race its writes.
    let _running = cancel.begin()?;
    let prepared = import::prepare_zip_import(&root, Path::new(&path))?;
    if prepared.remote_asset_count() > 0 {
        emit_import_progress(&app, "downloading", 0, prepared.remote_asset_count());
    }
    let download_app = app.clone();
    let downloads = prepared
        .download_assets(
            cancel.flag(),
            std::sync::Arc::new(move |done, total| {
                emit_import_progress(&download_app, "downloading", done, total);
            }),
        )
        .await?;
    // The downloads can take a while; refuse to write into a graph the user
    // has switched away from (or an import the user cancelled) in the
    // meantime — nothing has been written yet.
    cancel.ensure_active()?;
    root_for_generation(&state, generation)?;
    // Writing is fast and local; throttle the events to ~100 per import so a
    // large graph doesn't flood the webview.
    let mut last_emitted = 0usize;
    import::finalize_import(&root, prepared, downloads, |done, total| {
        let step = (total / 100).max(1);
        if done == total || done >= last_emitted + step {
            last_emitted = done;
            emit_import_progress(&app, "writing", done, total);
        }
    })
}

/// Cancel the running Reflect V1 import (a no-op when none is running). The
/// import aborts before any graph write, so cancellation is always safe.
#[tauri::command]
pub fn graph_import_cancel(cancel: State<ImportCancel>) {
    cancel.cancel();
}

fn emit_import_progress(app: &tauri::AppHandle, stage: &'static str, done: usize, total: usize) {
    let _ = app.emit(
        "import:progress",
        import::ImportProgress { stage, done, total },
    );
}

/// Open an existing graph at `path`, ensuring the standard layout exists.
#[tauri::command]
pub fn graph_open(path: String, state: State<GraphState>) -> AppResult<GraphInfo> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::not_found(format!("not a directory: {path}")));
    }
    bootstrap(&root)?;
    activate(&state, &root)
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
/// Returns the written file's on-disk mtime (epoch ms, `None` when the
/// platform can't provide one) so the caller's index echo can stamp the row
/// with the value a later `list_files` will report — a `Date.now()` stamp
/// never matches and costs a re-read on every reconcile.
#[tauri::command]
pub fn note_write(
    path: String,
    contents: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<Option<u64>> {
    let root = root_for_generation(&state, generation)?;
    atomic_write(&root, &resolve(&root, &path)?, &contents)
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
    atomic_write_bytes(&root, &resolve(&root, &path)?, &bytes)?;
    Ok(())
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

/// Open a graph asset in the OS default application. The frontend supplies the
/// graph-relative `assets/...` path from markdown; Rust resolves it inside the
/// generation-pinned graph so the JS opener never gets broad filesystem access.
#[tauri::command]
pub fn asset_open(
    path: String,
    generation: u64,
    app: tauri::AppHandle,
    state: State<GraphState>,
) -> AppResult<()> {
    ensure_asset_path(&path)?;
    let root = root_for_generation(&state, generation)?;
    let abs = resolve(&root, &path)?;
    if !abs.is_file() {
        return Err(AppError::not_found(format!("asset not found: {path}")));
    }
    open_asset_path(&app, &abs)
}

#[cfg(target_os = "ios")]
fn open_asset_path(app: &tauri::AppHandle, path: &Path) -> AppResult<()> {
    let url = asset_file_url(path)?;
    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|err| AppError::io(err.to_string()))
}

#[cfg(not(target_os = "ios"))]
fn open_asset_path(app: &tauri::AppHandle, path: &Path) -> AppResult<()> {
    app.opener()
        .open_path(path.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|err| AppError::io(err.to_string()))
}

#[cfg(any(target_os = "ios", test))]
fn asset_file_url(path: &Path) -> AppResult<tauri::Url> {
    tauri::Url::from_file_path(path).map_err(|()| {
        AppError::io(format!(
            "failed to convert asset path to file URL: {}",
            path.display()
        ))
    })
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
    // Occupied, not merely readable: an iCloud-evicted note is only a stub on
    // disk, but creating a new note at its path would collide the moment the
    // real file re-downloads (Plan 21).
    Ok(io::file_occupied(&resolve(&root, &path)?))
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
    // Occupied includes an evicted iCloud note (placeholder only on disk):
    // renaming onto it would collide with the re-download (Plan 21).
    if io::file_occupied(&to_abs) {
        return Err(AppError::io(format!(
            "cannot move note: {to} already exists on disk"
        )));
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(from_abs, to_abs)?;
    // Carry the note's sync ancestor across the rename (Plan 21) — a missed
    // move only degrades one future merge, never blocks the rename.
    crate::conflict::shadow::ShadowStore::new(root).record_move(from, to);
    Ok(())
}

/// Send a note to the OS trash (recoverable), not a hard delete (pinned to
/// `generation`). Mobile has no OS trash: the file moves into the graph-local
/// `.reflect/trash/` instead (Plan 19), the same recoverability promise, and
/// `.reflect/` is already excluded from sync and indexing.
#[tauri::command]
pub fn note_delete(path: String, generation: u64, state: State<GraphState>) -> AppResult<()> {
    let root = root_for_generation(&state, generation)?;
    let abs = resolve(&root, &path)?;
    // An iCloud-evicted note exists only as its `.name.md.icloud` stub —
    // trashing the logical path would fail and the note would be
    // undeletable. Removing the stub deletes the iCloud item (Plan 21).
    let target = if abs.exists() {
        abs
    } else {
        io::eviction_placeholder(&abs)
            .filter(|stub| stub.exists())
            .unwrap_or(abs)
    };
    #[cfg(desktop)]
    os_trash_delete(&target)?;
    #[cfg(mobile)]
    move_to_graph_trash(&root, &target)?;
    // A deleted note's sync ancestor is meaningless — drop it (Plan 21).
    crate::conflict::shadow::ShadowStore::new(&root).forget(&path);
    Ok(())
}

/// Move the open graph's **entire directory** to the OS trash (recoverable)
/// and drop it from recents. The session is invalidated (root cleared,
/// generation bumped) **before** the filesystem is touched: a concurrent
/// write pinned to this generation must fail its root check instead of
/// `create_dir_all`-recreating directories under a path being trashed. If
/// the trash move itself then fails, the session stays invalidated and the
/// frontend re-opens the intact directory to restore a writable session.
/// Pinned to `generation` — a delete enqueued before a graph switch must
/// never trash the newly opened graph. Desktop-only: mobile's fixed roots
/// have no OS trash and no delete UI.
#[tauri::command]
pub fn graph_delete(generation: u64, state: State<GraphState>) -> AppResult<()> {
    #[cfg(desktop)]
    {
        // Check-and-invalidate under one lock hold — `root_for_generation`
        // followed by a separate invalidation would leave a window where a
        // pinned write still resolves the doomed root.
        let root = {
            let mut inner = lock_graph(&state)?;
            if inner.generation != generation {
                return Err(AppError::io(
                    "the graph changed since this command was issued; dropping it",
                ));
            }
            let root = inner.root.take().ok_or_else(AppError::no_graph)?;
            inner.generation += 1;
            root
        };
        os_trash_delete(&root)?;
        // Recents is a convenience cache (same stance as `activate`): the
        // directory is already in the trash, so a failure to persist must not
        // report the delete as failed. A stale entry fails loudly on open.
        if let Err(err) = crate::recents::forget(&root.to_string_lossy()) {
            tracing::warn!(?err, "failed to forget deleted graph");
        }
        Ok(())
    }
    #[cfg(mobile)]
    {
        let _ = (generation, &state);
        Err(AppError::io(
            "deleting a graph is not supported on this platform",
        ))
    }
}

/// Send a file to the OS trash. On macOS, use `NSFileManager.trashItemAtURL`
/// (`DeleteMethod::NsFileManager`) instead of the `trash` crate default, which
/// drives Finder over AppleScript and fails with `-10010` ("Handler can't
/// handle objects of this class") when the graph lives on a cloud-synced or
/// network volume. The NsFileManager path needs no Automation permission, makes
/// no sound, and still lands the file in the system Trash for recovery.
#[cfg(desktop)]
fn os_trash_delete(abs: &Path) -> AppResult<()> {
    #[cfg(target_os = "macos")]
    let ctx = {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut ctx = trash::TrashContext::default();
        ctx.set_delete_method(DeleteMethod::NsFileManager);
        ctx
    };
    #[cfg(not(target_os = "macos"))]
    let ctx = trash::TrashContext::default();

    ctx.delete(abs).map_err(|err| AppError::io(err.to_string()))
}

/// Move a deleted file under `<graph>/.reflect/trash/`, stamping the name
/// with epoch millis — and a counter beyond that — until the name is free
/// (repeat deletes of `a.md`, even within one millisecond).
#[cfg(mobile)]
fn move_to_graph_trash(root: &Path, abs: &Path) -> AppResult<()> {
    let trash_dir = root.join(".reflect").join("trash");
    fs::create_dir_all(&trash_dir)?;
    let name = abs
        .file_name()
        .ok_or_else(|| AppError::io("delete target has no file name"))?;
    let name = Path::new(name);
    let stem = name
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("note");
    let ext = name.extension().and_then(|value| value.to_str());
    let with_suffix = |suffix: &str| match ext {
        Some(ext) => format!("{stem}{suffix}.{ext}"),
        None => format!("{stem}{suffix}"),
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|err| AppError::io(err.to_string()))?
        .as_millis();
    let mut target = trash_dir.join(with_suffix(""));
    let mut attempt: u32 = 0;
    while target.exists() {
        attempt += 1;
        let suffix = if attempt == 1 {
            format!("-{millis}")
        } else {
            format!("-{millis}-{attempt}")
        };
        target = trash_dir.join(with_suffix(&suffix));
    }
    fs::rename(abs, target)?;
    Ok(())
}

/// List markdown notes under `daily/` and `notes/`. `generation`, when given,
/// pins the listing to the issuing graph session (see [`root_for`]).
#[tauri::command]
pub fn list_files(generation: Option<u64>, state: State<GraphState>) -> AppResult<Vec<FileMeta>> {
    let root = root_for(&state, generation)?;
    note_files(&root)
}

/// The same note listing as [`list_files`], callable with a plain root —
/// the iCloud conflict sweep walks the graph outside any Tauri state.
pub(crate) fn note_files(root: &Path) -> AppResult<Vec<FileMeta>> {
    let mut out = Vec::new();
    for dir in NOTE_DIRS {
        collect_files(root, dir, Some("md"), &mut out)?;
    }
    Ok(out)
}

#[cfg(test)]
mod move_tests {
    use super::{asset_file_url, ensure_asset_path, move_note_file};
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

    #[test]
    fn an_evicted_destination_also_refuses() {
        // The destination exists only as an iCloud eviction placeholder — it
        // looks vacant to is_file(), but the real note comes back on
        // re-download, so the rename must refuse exactly like a present file.
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();
        fs::write(root.path().join("notes/.b.md.icloud"), "stub").unwrap();
        assert!(move_note_file(root.path(), "notes/a.md", "notes/b.md").is_err());
        assert!(root.path().join("notes/a.md").exists());
    }

    #[test]
    fn asset_open_paths_must_stay_under_assets() {
        assert!(ensure_asset_path("assets/cat.png").is_ok());
        assert!(ensure_asset_path("notes/cat.png").is_err());
        assert!(ensure_asset_path("assets/").is_err());
        assert!(ensure_asset_path("assets").is_err());
    }

    #[test]
    fn asset_file_url_percent_encodes_local_paths() {
        let path = std::env::temp_dir().join("Reflect Cat Photo.png");
        let url = asset_file_url(&path).unwrap();

        assert_eq!(url.scheme(), "file");
        assert!(url.as_str().contains("Reflect%20Cat%20Photo.png"));
    }
}
