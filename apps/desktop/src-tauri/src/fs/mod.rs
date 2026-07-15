//! Graph file-IO primitives (Plan 02).
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative** — the graph root lives
//! in Rust state and the frontend can never address files outside it
//! (path-traversal guard, [`resolve`]). Writes are atomic (temp file + rename,
//! [`io`]) and deletes go to the OS trash. Parsing/indexing live in later plans.

pub mod asset_protocol;
pub mod assets;
mod attachments;
mod import;
mod import_assets;
mod io;
mod resolve;

use std::fs;
use std::path::{Path, PathBuf};
#[cfg(desktop)]
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(desktop)]
use cap_fs_ext::DirExt;
use cap_std::ambient_authority;
use cap_std::fs::Dir;
use serde::Serialize;
use tauri::{Emitter, State};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};

use self::io::{
    atomic_create_pinned, atomic_write_bytes_pinned, atomic_write_if_unchanged_pinned,
    atomic_write_pinned, bootstrap, initialize_runtime, AtomicConditionalWriteOutcome,
    AtomicCreateOutcome,
};
use self::resolve::resolve;

/// Cancellation flag for the running Reflect V1 import, managed as Tauri
/// state in `lib.rs` (`graph_import_cancel` trips it).
pub use self::import::ImportCancel;

/// Atomic byte write staged under `.reflect/tmp/`, shared with the conflict
/// machinery (shadow bases, resolution writes) so every graph write follows
/// the same crash-safe, sync-clean path.
pub(crate) use self::io::atomic_write_bytes;

/// "Occupied" probe (real file OR eviction placeholder), shared with the
/// iCloud sweep's collision folding — an evicted canonical note must not be
/// treated as a free slot (Plan 21).
pub(crate) use self::io::file_occupied;
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
/// iCloud eviction-placeholder path construction, shared with note deletion
/// and the desktop watcher (which treats an evicted note as present).
pub(crate) use reflect_graph_paths::eviction_placeholder;
/// iCloud eviction-placeholder name mapping, shared with container discovery.
#[cfg(any(target_os = "ios", target_os = "macos"))]
pub(crate) use reflect_graph_paths::icloud_placeholder_target;

/// The open graph root plus a monotonic generation, kept **under one lock** so
/// they swap atomically (the same pattern as the index's `IndexState`, Plan 04b).
/// Mutating commands carry the generation they were issued for and are rejected
/// when it's stale — so a write enqueued for one graph can never land in another
/// graph's same-named file after a switch swaps the root.
#[derive(Default)]
pub struct GraphInner {
    pub generation: u64,
    pub root: Option<PathBuf>,
    root_capability: Option<Arc<Dir>>,
    catalog: Option<io::FileCatalog>,
    /// Monotonic invalidation epoch. A scan may run without the graph lock;
    /// it can populate the cache only if no write/watcher invalidated the
    /// catalog since that scan began.
    catalog_revision: u64,
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
#[derive(Clone, Serialize)]
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

/// One note body captured by the uncached AI privacy snapshot.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPrivacySnapshotNote {
    pub path: String,
    pub source: String,
}

/// One revision-stable, generation-pinned view used before any managed asset
/// content can reach an AI provider. Unlike the ordinary file catalog this is
/// never read from, nor written into, the shared cache.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPrivacySnapshot {
    pub revision: u64,
    pub notes: Vec<AssetPrivacySnapshotNote>,
    pub attachments: Vec<FileMeta>,
}

/// Event emitted after the active graph's shared note/attachment catalog is
/// invalidated by a filesystem source that cannot safely use `index:changed`
/// for every transition (notably iCloud eviction placeholders).
pub(crate) const FILE_CATALOG_CHANGED_EVENT: &str = "graph:catalog-changed";

const MAX_NOTE_READ_BYTES: u64 = 32 * 1024 * 1024;
const MAX_ASSET_IPC_READ_BYTES: u64 = 128 * 1024 * 1024;
const MAX_AI_MANAGED_ASSET_READ_BYTES: u64 = 20 * 1024 * 1024;
const MAX_ASSET_DESCRIPTION_READ_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PRIVACY_SNAPSHOT_BYTES: u64 = 128 * 1024 * 1024;
const MAX_PRIVACY_SNAPSHOT_ATTEMPTS: usize = 3;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCatalogChanged {
    generation: u64,
}

/// A directory handle and its display path captured from one graph generation.
/// File IO uses the capability; the path is retained only for APIs such as
/// iCloud requests, OS open, and OS Trash that require an ambient pathname.
#[derive(Clone)]
pub(crate) struct PinnedGraphRoot {
    path: PathBuf,
    capability: Arc<Dir>,
}

impl PinnedGraphRoot {
    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

/// Result of claiming a note path without overwriting an existing file.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum NoteCreateOutcome {
    /// The path was free and now contains the supplied bytes.
    Created { modified_ms: Option<u64> },
    /// A file or iCloud eviction placeholder already owns the path.
    Collision,
}

/// Result of writing a note only while its last-read bytes remain current.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum NoteWriteIfUnchangedOutcome {
    Written { modified_ms: Option<u64> },
    Changed,
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
    let root_capability = Arc::new(Dir::open_ambient_dir(root, ambient_authority())?);
    let generation = {
        let mut inner = lock_graph(state)?;
        inner.generation += 1;
        inner.root = Some(root.to_path_buf());
        inner.root_capability = Some(root_capability);
        inner.catalog = None;
        inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
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

fn lock_graph(state: &GraphState) -> AppResult<std::sync::MutexGuard<'_, GraphInner>> {
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

/// The active graph's path and already-open root directory capability, pinned
/// atomically to the generation that issued a filesystem operation.
pub(crate) fn pinned_root_for_generation(
    state: &State<GraphState>,
    generation: u64,
) -> AppResult<PinnedGraphRoot> {
    pinned_root_for_generation_inner(state, generation)
}

pub(crate) fn pinned_root_for_generation_inner(
    state: &GraphState,
    generation: u64,
) -> AppResult<PinnedGraphRoot> {
    pinned_root(state, Some(generation))
}

fn pinned_root(state: &GraphState, generation: Option<u64>) -> AppResult<PinnedGraphRoot> {
    let inner = lock_graph(state)?;
    if generation.is_some_and(|generation| inner.generation != generation) {
        return Err(AppError::io(
            "the graph changed since this command was issued; dropping it",
        ));
    }
    Ok(PinnedGraphRoot {
        path: inner.root.clone().ok_or_else(AppError::no_graph)?,
        capability: inner
            .root_capability
            .clone()
            .ok_or_else(AppError::no_graph)?,
    })
}

fn ensure_note_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::classify_normalized(path)
        == Some(reflect_graph_paths::GraphPathKind::Note)
    {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "note command rejected an ineligible path: {path}"
    )))
}

fn ensure_reserved_attachment_path(path: &str) -> AppResult<()> {
    let in_reserved_tree = path.starts_with("assets/") || path.starts_with("audio-memos/");
    if in_reserved_tree
        && reflect_graph_paths::classify_normalized(path)
            == Some(reflect_graph_paths::GraphPathKind::Attachment)
    {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "asset command rejected an ineligible path: {path}"
    )))
}

fn ensure_listable_directory(path: &str) -> AppResult<()> {
    if matches!(path, "assets" | "audio-memos") {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "directory listing is restricted to attachment roots: {path}"
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
/// Storage or Reflect's asset CDN are downloaded into `assets/` first and the
/// links rewritten, so the imported graph doesn't depend on Reflect V1's
/// infrastructure staying up. Progress is emitted as `import:progress` events,
/// and [`graph_import_cancel`] aborts the run before anything lands in the
/// graph.
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
    let user_agent = crate::app_user_agent(&app);
    let downloads = prepared
        .download_assets(
            &user_agent,
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
    let summary = import::finalize_import(&root, prepared, downloads, |done, total| {
        let step = (total / 100).max(1);
        if done == total || done >= last_emitted + step {
            last_emitted = done;
            emit_import_progress(&app, "writing", done, total);
        }
    })?;
    invalidate_file_catalog(&state, &root);
    Ok(summary)
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

/// Open an existing Markdown vault in place, adding only `.reflect/` runtime
/// state. Reflect's authoring directories remain lazy for adopted vaults.
#[tauri::command]
pub fn graph_open(path: String, state: State<GraphState>) -> AppResult<GraphInfo> {
    let root = PathBuf::from(&path);
    if !root.is_dir() {
        return Err(AppError::not_found(format!("not a directory: {path}")));
    }
    initialize_runtime(&root)?;
    activate(&state, &root)
}

/// Read a note's markdown by graph-relative path. `generation`, when given,
/// pins the read to the issuing graph session.
#[tauri::command]
pub fn note_read(
    path: String,
    generation: Option<u64>,
    state: State<GraphState>,
) -> AppResult<String> {
    note_read_for(&state, &path, generation)
}

fn note_read_for(state: &GraphState, path: &str, generation: Option<u64>) -> AppResult<String> {
    ensure_note_path(path)?;
    let root = pinned_root(state, generation)?;
    ensure_pinned_root_path_identity(&root)?;
    let bytes = attachments::read_existing_visible_file(&root, path, MAX_NOTE_READ_BYTES)?;
    String::from_utf8(bytes)
        .map_err(|error| AppError::parse(format!("note is not UTF-8 ({path}): {error}")))
}

/// Atomically write a note's markdown by graph-relative path. `generation` pins
/// the write to the graph capability it was issued for.
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
    ensure_note_path(&path)?;
    let root = pinned_root_for_generation(&state, generation)?;
    let modified_ms = atomic_write_pinned(&root, &path, &contents)?;
    invalidate_file_catalog(&state, root.path());
    Ok(modified_ms)
}

/// Optimistically compare the current note with `expected`, then atomically
/// replace it after final validation. `expected: null` means the path must
/// still be absent and takes the native no-clobber create path. Other command-
/// layer mutations cannot enter between validation and commit; a writer that
/// does not share the commit lock can still race the final filesystem rename,
/// so watcher reconciliation remains authoritative.
#[tauri::command]
pub fn note_write_if_unchanged(
    path: String,
    expected: Option<String>,
    contents: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<NoteWriteIfUnchangedOutcome> {
    ensure_note_path(&path)?;
    let root = pinned_root_for_generation(&state, generation)?;
    match atomic_write_if_unchanged_pinned(&root, &path, expected.as_deref(), &contents)? {
        AtomicConditionalWriteOutcome::Written(modified_ms) => {
            invalidate_file_catalog(&state, root.path());
            Ok(NoteWriteIfUnchangedOutcome::Written { modified_ms })
        }
        AtomicConditionalWriteOutcome::Changed => Ok(NoteWriteIfUnchangedOutcome::Changed),
    }
}

/// Atomically create a note only when `path` is still free. Unlike
/// [`note_write`], this is a no-clobber claim: a concurrent sync checkout or
/// creator wins as `Collision`, with its file left byte-for-byte intact.
#[tauri::command]
pub fn note_create(
    path: String,
    contents: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<NoteCreateOutcome> {
    ensure_note_path(&path)?;
    let root = pinned_root_for_generation(&state, generation)?;
    match atomic_create_pinned(&root, &path, &contents)? {
        AtomicCreateOutcome::Created(modified_ms) => {
            invalidate_file_catalog(&state, root.path());
            Ok(NoteCreateOutcome::Created { modified_ms })
        }
        AtomicCreateOutcome::Collision => Ok(NoteCreateOutcome::Collision),
    }
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
    ensure_reserved_attachment_path(&path)?;
    let root = pinned_root_for_generation(&state, generation)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_base64.as_bytes())
        .map_err(|err| AppError::io(format!("invalid base64 asset payload: {err}")))?;
    atomic_write_bytes_pinned(&root, &path, &bytes)?;
    invalidate_file_catalog(&state, root.path());
    Ok(())
}

/// Read a binary asset's bytes, base64-encoded for the JSON IPC (e.g. audio
/// memos read back for transcription). Pinned to `generation`, unlike
/// `note_read`: the caller is a background pass that can span a graph
/// switch, and an unpinned read would resolve against the *new* root —
/// handing back (and possibly sending to a provider) another graph's file.
#[tauri::command]
pub fn asset_read(path: String, generation: u64, state: State<GraphState>) -> AppResult<String> {
    asset_read_for(&state, &path, generation)
}

fn asset_read_for(state: &GraphState, path: &str, generation: u64) -> AppResult<String> {
    use base64::Engine;
    ensure_reserved_attachment_path(path)?;
    let root = pinned_root_for_generation_inner(state, generation)?;
    ensure_pinned_root_path_identity(&root)?;
    let bytes = attachments::read_existing_visible_file(&root, path, MAX_ASSET_IPC_READ_BYTES)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

const AI_MANAGED_ASSET_EXTENSIONS: [&str; 9] = [
    "avif", "bmp", "gif", "jpeg", "jpg", "pdf", "png", "svg", "webp",
];

fn ensure_ai_managed_asset_path(path: &str) -> AppResult<()> {
    attachments::ensure_supported_path(path)?;
    if !path.starts_with("assets/") {
        return Err(AppError::traversal(format!(
            "AI-managed asset is outside assets/: {path}"
        )));
    }
    let extension = path.rsplit_once('.').map_or("", |(_, extension)| extension);
    if !AI_MANAGED_ASSET_EXTENSIONS
        .iter()
        .any(|supported| extension.eq_ignore_ascii_case(supported))
    {
        return Err(AppError::parse(format!(
            "unsupported AI-managed asset format: {path}"
        )));
    }
    Ok(())
}

/// Read bytes for a Reflect-managed AI asset through the generation-pinned
/// root capability. No path component may be a symlink.
#[tauri::command]
pub fn managed_asset_read(
    path: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<String> {
    managed_asset_read_for(&state, &path, generation)
}

fn managed_asset_read_for(state: &GraphState, path: &str, generation: u64) -> AppResult<String> {
    use base64::Engine;
    ensure_ai_managed_asset_path(path)?;
    let root = pinned_root_for_generation_inner(state, generation)?;
    let bytes =
        attachments::read_existing_visible_file(&root, path, MAX_AI_MANAGED_ASSET_READ_BYTES)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// Read a Reflect-managed asset description through the same no-follow root
/// capability as its source bytes. Missing descriptions return `None`; a
/// symlink or any other unsafe path remains an error and is never followed.
#[tauri::command]
pub fn managed_asset_description_read(
    path: String,
    generation: Option<u64>,
    state: State<GraphState>,
) -> AppResult<Option<String>> {
    managed_asset_description_read_for(&state, &path, generation)
}

fn managed_asset_description_read_for(
    state: &GraphState,
    path: &str,
    generation: Option<u64>,
) -> AppResult<Option<String>> {
    ensure_ai_managed_asset_path(path)?;
    let root = pinned_root(state, generation)?;
    ensure_pinned_root_path_identity(&root)?;
    let description_path = format!("{path}.reflect.md");
    match attachments::read_existing_visible_file(
        &root,
        &description_path,
        MAX_ASSET_DESCRIPTION_READ_BYTES,
    ) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|error| AppError::parse(format!("asset description is not UTF-8: {error}"))),
        Err(AppError::NotFound { .. }) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Write a Reflect-managed asset description without reopening the generic
/// note-file boundary to reserved attachment metadata.
#[tauri::command]
pub fn managed_asset_description_write(
    path: String,
    contents: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<Option<u64>> {
    managed_asset_description_write_for(&state, &path, &contents, generation)
}

fn managed_asset_description_write_for(
    state: &GraphState,
    path: &str,
    contents: &str,
    generation: u64,
) -> AppResult<Option<u64>> {
    ensure_ai_managed_asset_path(path)?;
    let root = pinned_root_for_generation_inner(state, generation)?;
    let description_path = format!("{path}.reflect.md");
    let modified_ms = atomic_write_pinned(&root, &description_path, contents)?;
    invalidate_file_catalog(state, root.path());
    Ok(modified_ms)
}

/// Resolve a local Markdown or wiki-embed attachment without exposing the
/// graph's absolute path. The tagged result keeps missing, unavailable, and
/// ambiguous references distinct so the frontend never has to guess.
#[tauri::command]
pub async fn attachment_resolve(
    request: attachments::AttachmentResolveRequest,
    state: State<'_, GraphState>,
) -> AppResult<attachments::AttachmentResolveOutcome> {
    let root = pinned_root_for_generation(&state, request.generation)?;
    let resolver_root = root.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        attachments::resolve_reference(
            &resolver_root,
            &request.source_path,
            &request.reference,
            request.reference_kind,
        )
    })
    .await
    .map_err(|err| AppError::io(format!("attachment resolver task failed: {err}")))??;
    if let attachments::AttachmentResolveOutcome::Unavailable { path } = &outcome {
        attachments::request_materialization(&root, path)?;
    }
    Ok(outcome)
}

/// Open a resolved in-vault attachment in the OS default application. Protocol
/// URLs and IPC calls are independently forgeable, so this revalidates the
/// supported extension, visible path policy, and symlink-free ancestry.
#[tauri::command]
pub fn asset_open(
    path: String,
    generation: u64,
    app: tauri::AppHandle,
    state: State<GraphState>,
) -> AppResult<()> {
    let root = pinned_root_for_generation(&state, generation)?;
    let attachment = attachments::open_existing_attachment(&root, &path)?;
    let launch_guard = attachments::revalidate_for_path_launch(&root, &path, &attachment)?;
    open_asset_path(&app, launch_guard.absolute_path())
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

/// List every file under one reserved attachment root (`assets` or
/// `audio-memos`). A missing directory lists as empty. Pinned to `generation`
/// for the same reason as `asset_read` — the listing seeds a background pass
/// that must never mix graphs.
#[tauri::command]
pub fn dir_list(
    dir: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<Vec<FileMeta>> {
    ensure_listable_directory(&dir)?;
    let root = pinned_root_for_generation(&state, generation)?;
    attachments::list_reserved_files(&root, &dir)
}

/// Does a graph-relative path currently exist as a file? The collision picker
/// (Plan 17) probes disk as well as the index — the index lags the watcher by
/// a debounce, and an unindexed file must never be clobbered by a new note.
#[tauri::command]
pub fn note_exists(path: String, state: State<GraphState>) -> AppResult<bool> {
    ensure_note_path(&path)?;
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
pub(crate) fn move_note_file(root: &PinnedGraphRoot, from: &str, to: &str) -> AppResult<()> {
    ensure_note_path(from)?;
    ensure_note_path(to)?;
    io::move_file_pinned(root, from, to)?;
    // Carry the note's sync ancestor across the rename (Plan 21) — a missed
    // move only degrades one future merge, never blocks the rename.
    io::move_shadow_entries_pinned(root, from, to);
    Ok(())
}

/// Send a note to the OS trash (recoverable), not a hard delete (pinned to
/// `generation`). Mobile has no OS trash: the file moves into the graph-local
/// `.reflect/trash/` instead (Plan 19), the same recoverability promise, and
/// `.reflect/` is already excluded from sync and indexing.
#[tauri::command]
pub fn note_delete(path: String, generation: u64, state: State<GraphState>) -> AppResult<()> {
    ensure_note_path(&path)?;
    let root = pinned_root_for_generation(&state, generation)?;
    // Detach the real file (or its iCloud placeholder) into the graph-local
    // recovery directory with a descriptor-relative, no-clobber rename. This
    // closes descendant symlink races before the desktop OS Trash pathname
    // boundary; mobile keeps this recovery entry as its Trash implementation.
    let staged = io::stage_delete_pinned(&root, &path)?;
    #[cfg(desktop)]
    {
        let target = match staged.revalidated_ambient_path(&root) {
            Ok(target) => target,
            Err(error) => {
                if let Err(rollback_error) = staged.rollback() {
                    tracing::error!(
                        ?rollback_error,
                        "failed to restore note after Trash path revalidation failed"
                    );
                }
                return Err(error);
            }
        };
        if let Err(error) = os_trash_delete(&target) {
            if let Err(rollback_error) = staged.rollback() {
                tracing::error!(
                    ?rollback_error,
                    "failed to restore note after the OS Trash operation failed"
                );
            }
            return Err(error);
        }
    }
    #[cfg(mobile)]
    drop(staged);
    // A deleted note's sync ancestor is meaningless — drop it (Plan 21).
    io::forget_shadow_entries_pinned(&root, &path);
    invalidate_file_catalog(&state, root.path());
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
        let root = invalidate_graph_for_delete(&state, generation)?;
        let root_path = trash_pinned_graph_root(root)?;
        // Recents is a convenience cache (same stance as `activate`): the
        // directory is already in the trash, so a failure to persist must not
        // report the delete as failed. A stale entry fails loudly on open.
        if let Err(err) = crate::recents::forget(&root_path.to_string_lossy()) {
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

#[cfg(desktop)]
fn invalidate_graph_for_delete(state: &GraphState, generation: u64) -> AppResult<PinnedGraphRoot> {
    let mut inner = lock_graph(state)?;
    if inner.generation != generation {
        return Err(AppError::io(
            "the graph changed since this command was issued; dropping it",
        ));
    }
    let root = PinnedGraphRoot {
        path: inner.root.clone().ok_or_else(AppError::no_graph)?,
        capability: inner
            .root_capability
            .clone()
            .ok_or_else(AppError::no_graph)?,
    };
    inner.root = None;
    inner.root_capability = None;
    inner.generation += 1;
    inner.catalog = None;
    inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
    Ok(root)
}

#[cfg(desktop)]
static GRAPH_DELETE_STAGE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A selected graph moved by descriptor into a unique sibling staging
/// directory. The original root name is preserved for the OS Trash item, but
/// the pathname-only API never receives the user-selected pathname after its
/// capability has been released on Windows.
#[cfg(desktop)]
struct StagedGraphRoot {
    original_path: PathBuf,
    root_name: PathBuf,
    parent_path: PathBuf,
    parent: Dir,
    parent_identity: same_file::Handle,
    staging_name: String,
    staging_path: PathBuf,
    staging_directory: Dir,
    staging_identity: same_file::Handle,
    root_identity: same_file::Handle,
}

#[cfg(desktop)]
impl StagedGraphRoot {
    fn revalidated_ambient_path(&self) -> AppResult<&Path> {
        let ambient_parent = Dir::open_ambient_dir(&self.parent_path, ambient_authority())
            .map_err(|error| {
                AppError::traversal(format!(
                    "graph-delete parent changed before the Trash handoff: {error}"
                ))
            })?;
        if graph_directory_identity(&ambient_parent)? != self.parent_identity {
            return Err(AppError::traversal(
                "graph-delete parent changed before the Trash handoff",
            ));
        }

        let ambient_staging = ambient_parent
            .open_dir_nofollow(&self.staging_name)
            .map_err(|error| {
                AppError::traversal(format!(
                    "graph-delete staging directory changed before the Trash handoff: {error}"
                ))
            })?;
        if graph_directory_identity(&ambient_staging)? != self.staging_identity {
            return Err(AppError::traversal(
                "graph-delete staging directory changed before the Trash handoff",
            ));
        }

        let staged_root = self
            .staging_directory
            .open_dir_nofollow(&self.root_name)
            .map_err(|error| {
                AppError::traversal(format!(
                    "staged graph changed before the Trash handoff: {error}"
                ))
            })?;
        if graph_directory_identity(&staged_root)? != self.root_identity {
            return Err(AppError::traversal(
                "staged graph changed before the Trash handoff",
            ));
        }
        let ambient_root_identity =
            same_file::Handle::from_path(&self.staging_path).map_err(|error| {
                AppError::traversal(format!(
                    "staged graph path changed before the Trash handoff: {error}"
                ))
            })?;
        if ambient_root_identity != self.root_identity {
            return Err(AppError::traversal(
                "staged graph path changed before the Trash handoff",
            ));
        }
        Ok(&self.staging_path)
    }

    fn rollback(self) -> AppResult<()> {
        let current = self
            .staging_directory
            .open_dir_nofollow(&self.root_name)
            .map_err(|error| {
                AppError::traversal(format!("staged graph could not be restored: {error}"))
            })?;
        if graph_directory_identity(&current)? != self.root_identity {
            return Err(AppError::traversal(
                "staged graph changed and could not be restored safely",
            ));
        }
        drop(current);
        io::rename_directory_noreplace(
            &self.staging_directory,
            &self.root_name,
            &self.parent,
            &self.root_name,
        )
        .map_err(|error| AppError::io(format!("staged graph could not be restored: {error}")))?;
        self.remove_empty_staging_directory();
        Ok(())
    }

    fn complete(self) {
        self.remove_empty_staging_directory();
    }

    fn remove_empty_staging_directory(self) {
        let StagedGraphRoot {
            parent,
            staging_name,
            staging_directory,
            staging_identity,
            ..
        } = self;
        drop(staging_directory);
        let Ok(current) = parent.open_dir_nofollow(&staging_name) else {
            return;
        };
        let current_matches =
            graph_directory_identity(&current).is_ok_and(|identity| identity == staging_identity);
        drop(current);
        drop(staging_identity);
        if current_matches {
            if let Err(error) = parent.remove_dir(&staging_name) {
                tracing::warn!(%error, "failed to remove empty graph-delete staging directory");
            }
        }
    }
}

#[cfg(desktop)]
fn graph_directory_identity(directory: &Dir) -> AppResult<same_file::Handle> {
    Ok(same_file::Handle::from_file(
        directory.try_clone()?.into_std_file(),
    )?)
}

#[cfg(desktop)]
fn create_graph_delete_staging(
    parent: &Dir,
    parent_path: &Path,
) -> AppResult<(String, PathBuf, Dir, same_file::Handle)> {
    for _ in 0..128 {
        let serial = GRAPH_DELETE_STAGE_COUNTER.fetch_add(1, Ordering::Relaxed);
        let staging_name = format!(".reflect-delete-stage-{}-{serial}", std::process::id());
        match parent.create_dir(&staging_name) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(AppError::io(error.to_string())),
        }
        let staging_path = parent_path.join(&staging_name);
        let staging_directory = match parent.open_dir_nofollow(&staging_name) {
            Ok(directory) => directory,
            Err(error) => {
                let _ = parent.remove_dir(&staging_name);
                return Err(AppError::traversal(format!(
                    "graph-delete staging directory could not be pinned: {error}"
                )));
            }
        };
        let capability_identity = match graph_directory_identity(&staging_directory) {
            Ok(identity) => identity,
            Err(error) => {
                drop(staging_directory);
                let _ = parent.remove_dir(&staging_name);
                return Err(error);
            }
        };
        let ambient_identity = match same_file::Handle::from_path(&staging_path) {
            Ok(identity) => identity,
            Err(error) => {
                drop(staging_directory);
                let _ = parent.remove_dir(&staging_name);
                return Err(AppError::traversal(format!(
                    "graph-delete staging directory path could not be pinned: {error}"
                )));
            }
        };
        if capability_identity != ambient_identity {
            drop(staging_directory);
            let _ = parent.remove_dir(&staging_name);
            return Err(AppError::traversal(
                "graph-delete staging directory was replaced while it was created",
            ));
        }
        return Ok((
            staging_name,
            staging_path,
            staging_directory,
            ambient_identity,
        ));
    }
    Err(AppError::io(
        "could not allocate a unique graph-delete staging directory",
    ))
}

#[cfg(desktop)]
fn stage_graph_root_for_delete(root: PinnedGraphRoot) -> AppResult<StagedGraphRoot> {
    stage_graph_root_for_delete_with(root, || {})
}

#[cfg(desktop)]
fn stage_graph_root_for_delete_with<F>(
    root: PinnedGraphRoot,
    after_root_release: F,
) -> AppResult<StagedGraphRoot>
where
    F: FnOnce(),
{
    ensure_pinned_root_path_identity(&root)?;
    let original_path = root.path.clone();
    let parent_path = original_path
        .parent()
        .ok_or_else(|| AppError::traversal("a filesystem root cannot be moved to Trash"))?
        .to_path_buf();
    let root_name = original_path
        .file_name()
        .ok_or_else(|| AppError::traversal("graph root has no directory name"))?;
    let root_name = PathBuf::from(root_name);
    let parent = Dir::open_ambient_dir(&parent_path, ambient_authority())?;
    let parent_identity = graph_directory_identity(&parent)?;

    // `same_file::Handle::from_path` uses a delete-sharing handle on Windows.
    // Retain that identity through the Trash call, but release the cap-std
    // root handle whose stricter sharing mode would prevent the staging move.
    let capability_identity = graph_directory_identity(&root.capability)?;
    let root_identity = same_file::Handle::from_path(&original_path)?;
    if capability_identity != root_identity {
        return Err(AppError::traversal(
            "the graph root path changed before delete staging",
        ));
    }
    drop(capability_identity);

    let (staging_name, staging_parent_path, staging_directory, staging_identity) =
        create_graph_delete_staging(&parent, &parent_path)?;
    let staging_path = staging_parent_path.join(&root_name);
    drop(root);
    after_root_release();

    if let Err(error) =
        io::rename_directory_noreplace(&parent, &root_name, &staging_directory, &root_name)
    {
        let root_path_changed = same_file::Handle::from_path(&original_path)
            .map_or(true, |current| current != root_identity);
        let staged = StagedGraphRoot {
            original_path,
            root_name,
            parent_path,
            parent,
            parent_identity,
            staging_name,
            staging_path,
            staging_directory,
            staging_identity,
            root_identity,
        };
        staged.complete();
        return if root_path_changed {
            Err(AppError::traversal(format!(
                "the graph root path changed before delete staging: {error}"
            )))
        } else {
            Err(AppError::io(format!(
                "graph could not be staged for Trash: {error}"
            )))
        };
    }

    let mut staged = StagedGraphRoot {
        original_path,
        root_name,
        parent_path,
        parent,
        parent_identity,
        staging_name,
        staging_path,
        staging_directory,
        staging_identity,
        root_identity,
    };
    let staged_root = match staged
        .staging_directory
        .open_dir_nofollow(&staged.root_name)
    {
        Ok(root) => root,
        Err(error) => {
            let recovery_path = staged.staging_path.clone();
            return match staged.rollback() {
                Ok(()) => Err(AppError::traversal(format!(
                    "staged graph could not be re-opened safely: {error}"
                ))),
                Err(rollback_error) => Err(AppError::traversal(format!(
                    "staged graph could not be re-opened; it may remain recoverable at {}: {error}; rollback failed: {rollback_error:?}",
                    recovery_path.display(),
                ))),
            };
        }
    };
    let staged_root_identity = match graph_directory_identity(&staged_root) {
        Ok(identity) => identity,
        Err(error) => {
            drop(staged_root);
            let recovery_path = staged.staging_path.clone();
            return match staged.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(AppError::traversal(format!(
                    "staged graph identity could not be verified; it may remain recoverable at {}: {error:?}; rollback failed: {rollback_error:?}",
                    recovery_path.display(),
                ))),
            };
        }
    };
    drop(staged_root);
    if staged_root_identity != staged.root_identity {
        staged.root_identity = staged_root_identity;
        let recovery_path = staged.staging_path.clone();
        return match staged.rollback() {
            Ok(()) => Err(AppError::traversal(
                "the graph root path was replaced after its capability was released",
            )),
            Err(rollback_error) => Err(AppError::traversal(format!(
                "the graph root path was replaced; its replacement remains recoverable at {} because rollback failed: {rollback_error:?}",
                recovery_path.display(),
            ))),
        };
    }
    Ok(staged)
}

/// Move the capability-validated graph to a unique sibling directory before
/// crossing the OS Trash pathname boundary. This closes the Windows race where
/// releasing the original capability made the selected pathname replaceable.
#[cfg(desktop)]
fn trash_pinned_graph_root(root: PinnedGraphRoot) -> AppResult<PathBuf> {
    let staged = stage_graph_root_for_delete(root)?;
    let root_path = staged.original_path.clone();
    let staged_path = match staged.revalidated_ambient_path() {
        Ok(path) => path.to_path_buf(),
        Err(error) => {
            let recovery_path = staged.staging_path.clone();
            return match staged.rollback() {
                Ok(()) => Err(error),
                Err(rollback_error) => Err(AppError::io(format!(
                    "{error:?}; the graph remains recoverable at {} because rollback failed: {rollback_error:?}",
                    recovery_path.display(),
                ))),
            };
        }
    };
    if let Err(error) = os_trash_delete(&staged_path) {
        let recovery_path = staged.staging_path.clone();
        return match staged.rollback() {
            Ok(()) => Err(error),
            Err(rollback_error) => Err(AppError::io(format!(
                "{error:?}; the graph remains recoverable at {} because rollback failed: {rollback_error:?}",
                recovery_path.display(),
            ))),
        };
    }
    staged.complete();
    Ok(root_path)
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

/// List eligible Markdown notes anywhere in the vault. `generation`, when
/// given, pins the listing to the issuing graph session (see [`root_for`]).
#[tauri::command]
pub fn list_files(generation: Option<u64>, state: State<GraphState>) -> AppResult<Vec<FileMeta>> {
    Ok(file_catalog(&state, generation)?.notes)
}

/// List supported local attachments through the graph capability pinned to
/// the requested generation. This deliberately bypasses the ambient-path
/// catalog walk so a renamed or replaced root cannot splice another vault's
/// files into an attachment result.
#[tauri::command]
pub fn list_attachments(
    generation: Option<u64>,
    state: State<GraphState>,
) -> AppResult<Vec<FileMeta>> {
    let root = pinned_root(&state, generation)?;
    attachments::list_supported_attachments(&root)
}

/// Capture every eligible note body and supported attachment from one stable
/// graph revision. This intentionally bypasses `file_catalog`: privacy checks
/// must see a private note created externally even when the editor-facing
/// catalog cache has not yet received its watcher invalidation.
#[tauri::command]
pub fn asset_privacy_snapshot(
    generation: u64,
    state: State<GraphState>,
) -> AppResult<AssetPrivacySnapshot> {
    asset_privacy_snapshot_for(&state, generation)
}

fn asset_privacy_snapshot_for(
    state: &GraphState,
    generation: u64,
) -> AppResult<AssetPrivacySnapshot> {
    asset_privacy_snapshot_with(state, generation, io::collect_file_catalog)
}

fn asset_privacy_snapshot_with<F>(
    state: &GraphState,
    generation: u64,
    mut scan: F,
) -> AppResult<AssetPrivacySnapshot>
where
    F: FnMut(&Path) -> AppResult<io::FileCatalog>,
{
    for attempt in 0..MAX_PRIVACY_SNAPSHOT_ATTEMPTS {
        let (root, revision) = {
            let inner = lock_graph(state)?;
            if inner.generation != generation {
                return Err(AppError::io(
                    "the graph changed since this command was issued; dropping it",
                ));
            }
            (
                PinnedGraphRoot {
                    path: inner.root.clone().ok_or_else(AppError::no_graph)?,
                    capability: inner
                        .root_capability
                        .clone()
                        .ok_or_else(AppError::no_graph)?,
                },
                inner.catalog_revision,
            )
        };

        // Native file mutations stage without this guard, then acquire it for
        // their final validation and namespace commit. Holding the same guard
        // through this live walk and revision check means each such commit is
        // either already visible to the scan or cannot land until the returned
        // snapshot has been fully captured.
        let _commit_guard = io::lock_mutation_commit()?;
        ensure_pinned_root_path_identity(&root)?;
        let catalog = scan(&root.path)?;
        let mut notes = Vec::with_capacity(catalog.notes.len());
        let mut total_note_bytes = 0_u64;
        for file in &catalog.notes {
            if file.placeholder {
                return Err(AppError::not_found(format!(
                    "privacy snapshot note is unavailable: {}",
                    file.path
                )));
            }
            if reflect_graph_paths::classify_normalized(&file.path)
                != Some(reflect_graph_paths::GraphPathKind::Note)
            {
                return Err(AppError::traversal(format!(
                    "privacy snapshot contained an invalid note path: {}",
                    file.path
                )));
            }
            let remaining_bytes = MAX_PRIVACY_SNAPSHOT_BYTES
                .checked_sub(total_note_bytes)
                .ok_or_else(|| AppError::io("privacy snapshot exceeded its byte limit"))?;
            let bytes = attachments::read_existing_visible_file(
                &root,
                &file.path,
                remaining_bytes.min(MAX_NOTE_READ_BYTES),
            )?;
            total_note_bytes = total_note_bytes
                .checked_add(bytes.len() as u64)
                .ok_or_else(|| AppError::io("privacy snapshot byte count overflowed"))?;
            let source = String::from_utf8(bytes).map_err(|error| {
                AppError::parse(format!(
                    "privacy snapshot note is not UTF-8 ({}): {error}",
                    file.path
                ))
            })?;
            notes.push(AssetPrivacySnapshotNote {
                path: file.path.clone(),
                source,
            });
        }
        // The manifest walk needs an ambient path, while note reads use the
        // pinned capability. Reject a root rename/replacement instead of ever
        // combining a replacement manifest with bodies from the old vault.
        ensure_pinned_root_path_identity(&root)?;

        let inner = lock_graph(state)?;
        if inner.generation != generation || inner.root.as_deref() != Some(root.path.as_path()) {
            return Err(AppError::io(
                "the graph changed while its privacy snapshot was being captured; dropping it",
            ));
        }
        if inner.catalog_revision != revision {
            if attempt + 1 == MAX_PRIVACY_SNAPSHOT_ATTEMPTS {
                return Err(AppError::io(
                    "the vault kept changing while its privacy snapshot was being captured",
                ));
            }
            continue;
        }
        return Ok(AssetPrivacySnapshot {
            revision,
            notes,
            attachments: catalog.attachments,
        });
    }
    unreachable!("privacy snapshot attempts are non-zero")
}

fn ensure_pinned_root_path_identity(root: &PinnedGraphRoot) -> AppResult<()> {
    use same_file::Handle;

    let current = Dir::open_ambient_dir(&root.path, ambient_authority()).map_err(|error| {
        AppError::traversal(format!(
            "the graph root path changed during a pinned operation: {error}"
        ))
    })?;
    let pinned_identity = Handle::from_file(root.capability.try_clone()?.into_std_file())?;
    let current_identity = Handle::from_file(current.into_std_file())?;
    if pinned_identity != current_identity {
        return Err(AppError::traversal(
            "the graph root path was replaced during a pinned operation",
        ));
    }
    Ok(())
}

/// The same note listing as [`list_files`], callable with a plain root —
/// the iCloud conflict sweep walks the graph outside any Tauri state.
pub(crate) fn note_files(root: &Path) -> AppResult<Vec<FileMeta>> {
    io::collect_note_files(root)
}

/// One uncached manifest of eligible notes and attachments. The watcher uses
/// this to recover descendant changes when a platform reports only a renamed
/// directory instead of one event per file.
pub(crate) fn catalog_files(root: &Path) -> AppResult<Vec<FileMeta>> {
    Ok(flatten_file_catalog(io::collect_file_catalog(root)?))
}

/// Snapshot the active generation's complete cached catalog for a long-lived
/// consumer such as the filesystem watcher. The caller re-checks this identity
/// while installing itself, so a graph switch cannot bind an old manifest to a
/// new session.
pub(crate) fn current_catalog_files(
    state: &GraphState,
) -> AppResult<(PathBuf, u64, Vec<FileMeta>)> {
    let (root, generation) = {
        let inner = lock_graph(state)?;
        (
            inner.root.clone().ok_or_else(AppError::no_graph)?,
            inner.generation,
        )
    };
    let catalog = file_catalog(state, Some(generation))?;
    let inner = lock_graph(state)?;
    if inner.generation != generation || inner.root.as_deref() != Some(root.as_path()) {
        return Err(AppError::io(
            "the graph changed while its file catalog was being captured; dropping it",
        ));
    }
    Ok((root, generation, flatten_file_catalog(catalog)))
}

fn flatten_file_catalog(mut catalog: io::FileCatalog) -> Vec<FileMeta> {
    catalog.notes.append(&mut catalog.attachments);
    catalog
        .notes
        .sort_by(|left, right| left.path.cmp(&right.path));
    catalog.notes
}

/// Cached note listing for the current graph. The first caller builds notes
/// and attachments in one walk; invalidation drops the whole snapshot.
pub(crate) fn current_note_files(state: &GraphState) -> AppResult<Vec<FileMeta>> {
    Ok(file_catalog(state, None)?.notes)
}

fn file_catalog(state: &GraphState, generation: Option<u64>) -> AppResult<io::FileCatalog> {
    file_catalog_with(state, generation, io::collect_file_catalog)
}

fn file_catalog_with<F>(
    state: &GraphState,
    generation: Option<u64>,
    mut scan: F,
) -> AppResult<io::FileCatalog>
where
    F: FnMut(&Path) -> AppResult<io::FileCatalog>,
{
    loop {
        let (root, expected_generation, expected_revision) = {
            let inner = lock_graph(state)?;
            if generation.is_some_and(|generation| generation != inner.generation) {
                return Err(AppError::io(
                    "the graph changed since this command was issued; dropping it",
                ));
            }
            if let Some(catalog) = &inner.catalog {
                return Ok(catalog.clone());
            }
            (
                inner.root.clone().ok_or_else(AppError::no_graph)?,
                inner.generation,
                inner.catalog_revision,
            )
        };

        let catalog = scan(&root)?;
        let mut inner = lock_graph(state)?;
        if inner.generation != expected_generation || inner.root.as_deref() != Some(root.as_path())
        {
            return Err(AppError::io(
                "the graph changed while its files were being listed; dropping the result",
            ));
        }
        if let Some(current) = &inner.catalog {
            return Ok(current.clone());
        }
        if inner.catalog_revision != expected_revision {
            // A write or watcher invalidated the catalog while traversal ran.
            // The scan is stale; retry from the new epoch instead of
            // resurrecting rows the invalidation deliberately dropped.
            continue;
        }
        inner.catalog = Some(catalog.clone());
        return Ok(catalog);
    }
}

/// Invalidate the catalog only if `root` is still the active generation's
/// root. A late watcher/iCloud callback for a previous graph is harmless.
pub(crate) fn invalidate_file_catalog(state: &GraphState, root: &Path) {
    let _ = invalidate_file_catalog_generation(state, root);
}

/// Invalidate the active catalog and notify generation-pinned frontend
/// consumers. This is separate from `index:changed`: an iCloud eviction is
/// neither an upsert nor a removal, but attachment resolution must immediately
/// stop serving its previous positive match.
pub(crate) fn invalidate_file_catalog_and_emit(
    app: &tauri::AppHandle,
    state: &GraphState,
    root: &Path,
) {
    if let Some(generation) = invalidate_file_catalog_generation(state, root) {
        let _ = app.emit(
            FILE_CATALOG_CHANGED_EVENT,
            FileCatalogChanged { generation },
        );
    }
}

fn invalidate_file_catalog_generation(state: &GraphState, root: &Path) -> Option<u64> {
    match state.0.lock() {
        Ok(mut inner) if inner.root.as_deref() == Some(root) => {
            inner.catalog = None;
            inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
            Some(inner.generation)
        }
        Ok(_) => None,
        Err(error) => {
            tracing::error!(
                ?error,
                "graph state lock poisoned while invalidating catalog"
            );
            None
        }
    }
}

#[cfg(test)]
mod note_create_tests {
    use super::NoteCreateOutcome;
    use serde_json::json;

    #[test]
    fn outcome_serializes_for_the_typescript_boundary() {
        assert_eq!(
            serde_json::to_value(NoteCreateOutcome::Created {
                modified_ms: Some(1_234),
            })
            .unwrap(),
            json!({ "kind": "created", "modifiedMs": 1_234 })
        );
        assert_eq!(
            serde_json::to_value(NoteCreateOutcome::Collision).unwrap(),
            json!({ "kind": "collision" })
        );
    }
}

#[cfg(test)]
mod file_catalog_tests {
    use super::{
        asset_privacy_snapshot_for, asset_privacy_snapshot_with, asset_read_for,
        ensure_listable_directory, ensure_note_path, ensure_reserved_attachment_path, file_catalog,
        file_catalog_with, invalidate_file_catalog, invalidate_file_catalog_generation,
        managed_asset_description_read_for, managed_asset_description_write_for,
        managed_asset_read_for, note_read_for, FileCatalogChanged, GraphInner, GraphState,
    };
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use serde_json::json;
    use std::fs;
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;

    fn graph_state(root: &std::path::Path, generation: u64) -> GraphState {
        GraphState(Mutex::new(GraphInner {
            generation,
            root: Some(root.to_path_buf()),
            root_capability: Some(Arc::new(
                Dir::open_ambient_dir(root, ambient_authority()).expect("root capability"),
            )),
            catalog: None,
            catalog_revision: 0,
        }))
    }

    #[test]
    fn native_file_boundaries_accept_only_eligible_notes_and_reserved_attachments() {
        for path in ["README.md", "Projects/plan.md", "daily/2026-07-14.md"] {
            assert!(ensure_note_path(path).is_ok(), "eligible note: {path}");
        }
        for path in [
            ".git/config",
            ".hidden.md",
            "Projects/.hidden/note.md",
            "assets/sidecar.md",
            "audio-memos/transcript.md",
            "README.MD",
            "Projects/plan.txt",
        ] {
            assert!(ensure_note_path(path).is_err(), "ineligible note: {path}");
        }

        for path in ["assets/image.png", "audio-memos/recording.webm"] {
            assert!(
                ensure_reserved_attachment_path(path).is_ok(),
                "eligible asset: {path}"
            );
        }
        for path in [
            "Media/image.png",
            "assets/.hidden.png",
            "assets/readme.txt",
            ".git/config.png",
        ] {
            assert!(
                ensure_reserved_attachment_path(path).is_err(),
                "ineligible asset: {path}"
            );
        }
        assert!(ensure_listable_directory("assets").is_ok());
        assert!(ensure_listable_directory("audio-memos").is_ok());
        for path in [".git", "notes", "assets/nested", "assets/"] {
            assert!(ensure_listable_directory(path).is_err());
        }
    }

    #[test]
    fn note_reads_use_the_pinned_capability_for_visible_markdown_only() {
        let vault = tempfile::tempdir().expect("vault");
        fs::create_dir(vault.path().join("Projects")).expect("projects");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("root note");
        fs::write(vault.path().join("Projects/plan.md"), "# Plan\n").expect("nested note");
        fs::create_dir(vault.path().join("assets")).expect("assets");
        fs::write(vault.path().join("assets/private.md"), "not a note").expect("sidecar");
        let graph = graph_state(vault.path(), 4);

        assert_eq!(
            note_read_for(&graph, "README.md", Some(4)).expect("root read"),
            "# Root\n"
        );
        assert_eq!(
            note_read_for(&graph, "Projects/plan.md", None).expect("nested read"),
            "# Plan\n"
        );
        assert!(note_read_for(&graph, "assets/private.md", Some(4)).is_err());
        assert!(note_read_for(&graph, ".git/config", Some(4)).is_err());
        assert!(note_read_for(&graph, "README.md", Some(3)).is_err());
    }

    #[test]
    fn generic_asset_reads_are_reserved_supported_and_generation_pinned() {
        let vault = tempfile::tempdir().expect("vault");
        fs::create_dir(vault.path().join("assets")).expect("assets");
        fs::write(vault.path().join("assets/a.png"), b"png").expect("asset");
        let graph = graph_state(vault.path(), 4);

        assert_eq!(asset_read_for(&graph, "assets/a.png", 4).unwrap(), "cG5n");
        for path in ["Media/a.png", "assets/.hidden.png", "assets/readme.txt"] {
            assert!(asset_read_for(&graph, path, 4).is_err());
        }
        assert!(asset_read_for(&graph, "assets/a.png", 3).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn generic_asset_reads_reject_symlinks() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().expect("vault");
        let outside = tempfile::tempdir().expect("outside");
        fs::create_dir(vault.path().join("assets")).expect("assets");
        fs::write(outside.path().join("a.png"), b"outside").expect("outside asset");
        symlink(
            outside.path().join("a.png"),
            vault.path().join("assets/a.png"),
        )
        .expect("asset symlink");
        let graph = graph_state(vault.path(), 4);

        assert!(matches!(
            asset_read_for(&graph, "assets/a.png", 4),
            Err(crate::error::AppError::Traversal { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn note_reads_reject_symlinks_and_a_replaced_root() {
        use std::os::unix::fs::symlink;

        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("vault");
        let moved = parent.path().join("moved");
        fs::create_dir(&root).expect("root");
        fs::write(root.join("real.md"), "outside through alias").expect("real note");
        symlink(root.join("real.md"), root.join("linked.md")).expect("note symlink");
        let graph = graph_state(&root, 5);
        assert!(matches!(
            note_read_for(&graph, "linked.md", Some(5)),
            Err(crate::error::AppError::Traversal { .. })
        ));

        fs::rename(&root, &moved).expect("move root");
        fs::create_dir(&root).expect("replacement root");
        fs::write(root.join("real.md"), "replacement").expect("replacement note");
        assert!(matches!(
            note_read_for(&graph, "real.md", Some(5)),
            Err(crate::error::AppError::Traversal { .. })
        ));
    }

    #[test]
    fn catalog_is_cached_until_invalidated_and_pinned_to_the_generation() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        fs::create_dir_all(vault.path().join("Media")).expect("create media");
        fs::write(vault.path().join("Media/diagram.png"), b"png").expect("write attachment");
        let graph = GraphState(Mutex::new(GraphInner {
            generation: 7,
            root: Some(vault.path().to_path_buf()),
            root_capability: None,
            catalog: None,
            catalog_revision: 0,
        }));

        let first = file_catalog(&graph, Some(7)).expect("first catalog");
        assert_eq!(first.notes[0].path, "README.md");
        assert_eq!(first.attachments[0].path, "Media/diagram.png");

        fs::create_dir_all(vault.path().join("Projects")).expect("create projects");
        fs::write(vault.path().join("Projects/plan.md"), "# Plan\n").expect("write nested note");
        let cached = file_catalog(&graph, Some(7)).expect("cached catalog");
        assert_eq!(cached.notes.len(), 1);

        invalidate_file_catalog(&graph, vault.path());
        let refreshed = file_catalog(&graph, Some(7)).expect("refreshed catalog");
        assert_eq!(
            refreshed
                .notes
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["Projects/plan.md", "README.md"]
        );

        assert!(file_catalog(&graph, Some(6)).is_err());
    }

    #[test]
    fn privacy_snapshot_bypasses_a_populated_catalog_cache() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Public\n").expect("public note");
        fs::create_dir(vault.path().join("assets")).expect("assets");
        fs::write(vault.path().join("assets/a.png"), b"png").expect("asset");
        let graph = graph_state(vault.path(), 7);

        let cached = file_catalog(&graph, Some(7)).expect("populate cache");
        assert_eq!(cached.notes.len(), 1);

        fs::create_dir(vault.path().join("Projects")).expect("projects");
        fs::write(
            vault.path().join("Projects/secret.md"),
            "---\nprivate: true\n---\n![](../assets/a.png)\n",
        )
        .expect("external private note");

        let snapshot = asset_privacy_snapshot_for(&graph, 7).expect("privacy snapshot");
        assert!(
            snapshot
                .notes
                .iter()
                .any(|note| note.path == "Projects/secret.md"
                    && note.source.contains("private: true"))
        );
        assert_eq!(snapshot.attachments[0].path, "assets/a.png");
        assert_eq!(
            file_catalog(&graph, Some(7))
                .expect("still cached")
                .notes
                .len(),
            1,
            "privacy scanning must not populate or refresh the shared cache"
        );
    }

    #[test]
    fn privacy_snapshot_serializes_native_commits_until_capture_finishes() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Before\n").expect("root note");
        fs::create_dir(vault.path().join(".reflect")).expect("runtime directory");
        let graph = Arc::new(graph_state(vault.path(), 3));
        let writer_root =
            super::pinned_root_for_generation_inner(&graph, 3).expect("pinned writer root");
        let snapshot_graph = Arc::clone(&graph);
        let (scan_started_tx, scan_started_rx) = mpsc::channel();
        let (continue_scan_tx, continue_scan_rx) = mpsc::channel();

        let snapshot_thread = thread::spawn(move || {
            asset_privacy_snapshot_with(&snapshot_graph, 3, |root| {
                scan_started_tx.send(()).expect("signal scan start");
                continue_scan_rx.recv().expect("continue scan");
                super::io::collect_file_catalog(root)
            })
        });

        scan_started_rx.recv().expect("scan started");
        let snapshot_holds_commit_lock = super::io::mutation_commit_lock_is_held_for_test();
        let writer_thread = thread::spawn(move || {
            super::io::atomic_write_pinned(&writer_root, "README.md", "# After\n")
        });
        continue_scan_tx.send(()).expect("release scan");

        let snapshot = snapshot_thread
            .join()
            .expect("snapshot thread")
            .expect("privacy snapshot");
        writer_thread
            .join()
            .expect("writer thread")
            .expect("native write");

        assert!(snapshot_holds_commit_lock);
        assert_eq!(snapshot.notes[0].source, "# Before\n");
        assert_eq!(
            fs::read_to_string(vault.path().join("README.md")).expect("written note"),
            "# After\n"
        );
    }

    #[test]
    fn privacy_snapshot_retries_when_its_revision_changes() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("root note");
        let graph = graph_state(vault.path(), 3);
        let mut scans = 0;

        let snapshot = asset_privacy_snapshot_with(&graph, 3, |root| {
            let catalog = super::io::collect_file_catalog(root)?;
            scans += 1;
            if scans == 1 {
                fs::write(root.join("arrived.md"), "# Arrived\n")?;
                invalidate_file_catalog(&graph, root);
            }
            Ok(catalog)
        })
        .expect("stable snapshot");

        assert_eq!(scans, 2);
        assert_eq!(
            snapshot
                .notes
                .iter()
                .map(|note| note.path.as_str())
                .collect::<Vec<_>>(),
            vec!["README.md", "arrived.md"]
        );
    }

    #[test]
    fn privacy_snapshot_fails_closed_after_bounded_unstable_retries() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("root note");
        let graph = graph_state(vault.path(), 3);
        let mut scans = 0;

        let error = asset_privacy_snapshot_with(&graph, 3, |root| {
            scans += 1;
            let catalog = super::io::collect_file_catalog(root)?;
            invalidate_file_catalog(&graph, root);
            Ok(catalog)
        })
        .err()
        .expect("a continuously changing snapshot must fail closed");

        assert_eq!(scans, super::MAX_PRIVACY_SNAPSHOT_ATTEMPTS);
        let crate::error::AppError::Io { message } = error else {
            panic!("unstable snapshot should return an IO error");
        };
        assert!(message.contains("kept changing"));
    }

    #[cfg(unix)]
    #[test]
    fn privacy_snapshot_rejects_a_replaced_ambient_root() {
        let parent = tempfile::tempdir().expect("parent");
        let root = parent.path().join("vault");
        let moved = parent.path().join("moved-vault");
        fs::create_dir(&root).expect("root");
        fs::write(
            root.join("secret.md"),
            "---\nprivate: true\n---\n![](assets/a.png)\n",
        )
        .expect("old private note");
        let graph = graph_state(&root, 5);

        fs::rename(&root, &moved).expect("move old root");
        fs::create_dir(&root).expect("replacement root");
        fs::write(root.join("README.md"), "# Replacement\n").expect("replacement note");

        assert!(matches!(
            asset_privacy_snapshot_for(&graph, 5),
            Err(crate::error::AppError::Traversal { .. })
        ));
    }

    #[cfg(unix)]
    #[test]
    fn managed_ai_reads_reject_symlinked_assets_and_sidecars() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().expect("vault");
        let outside = tempfile::tempdir().expect("outside");
        fs::create_dir(vault.path().join("assets")).expect("assets");
        fs::write(outside.path().join("a.png"), b"outside asset").expect("outside asset");
        fs::write(
            outside.path().join("a.png.reflect.md"),
            b"outside description",
        )
        .expect("outside sidecar");
        symlink(
            outside.path().join("a.png"),
            vault.path().join("assets/a.png"),
        )
        .expect("asset symlink");
        symlink(
            outside.path().join("a.png.reflect.md"),
            vault.path().join("assets/a.png.reflect.md"),
        )
        .expect("sidecar symlink");
        let graph = graph_state(vault.path(), 9);

        assert!(matches!(
            managed_asset_read_for(&graph, "assets/a.png", 9),
            Err(crate::error::AppError::Traversal { .. })
        ));
        assert!(matches!(
            managed_asset_description_read_for(&graph, "assets/a.png", Some(9)),
            Err(crate::error::AppError::Traversal { .. })
        ));
    }

    #[test]
    fn managed_description_writes_use_the_narrow_asset_path_boundary() {
        let vault = tempfile::tempdir().expect("vault");
        fs::create_dir(vault.path().join("assets")).expect("assets");
        let graph = graph_state(vault.path(), 9);

        managed_asset_description_write_for(&graph, "assets/a.png", "# Description\n", 9)
            .expect("description write");
        assert_eq!(
            fs::read_to_string(vault.path().join("assets/a.png.reflect.md"))
                .expect("description source"),
            "# Description\n"
        );
        assert!(managed_asset_description_write_for(
            &graph,
            "Media/a.png",
            "outside managed tree",
            9
        )
        .is_err());
        assert!(
            managed_asset_description_write_for(&graph, "assets/readme.txt", "unsupported", 9)
                .is_err()
        );
        assert!(managed_asset_description_write_for(&graph, "assets/a.png", "stale", 8).is_err());
    }

    #[test]
    fn invalidation_from_an_old_root_cannot_clear_the_active_catalog() {
        let vault = tempfile::tempdir().expect("vault");
        let old_vault = tempfile::tempdir().expect("old vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        let graph = GraphState(Mutex::new(GraphInner {
            generation: 3,
            root: Some(vault.path().to_path_buf()),
            root_capability: None,
            catalog: None,
            catalog_revision: 0,
        }));
        file_catalog(&graph, Some(3)).expect("catalog");

        invalidate_file_catalog(&graph, old_vault.path());

        assert!(graph.0.lock().expect("graph lock").catalog.is_some());
    }

    #[test]
    fn invalidation_during_a_scan_forces_a_fresh_catalog() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        let graph = GraphState(Mutex::new(GraphInner {
            generation: 5,
            root: Some(vault.path().to_path_buf()),
            root_capability: None,
            catalog: None,
            catalog_revision: 0,
        }));
        let mut scans = 0;

        let catalog = file_catalog_with(&graph, Some(5), |root| {
            let scanned = super::io::collect_file_catalog(root)?;
            scans += 1;
            if scans == 1 {
                fs::write(root.join("arrived.md"), "# Arrived\n")?;
                invalidate_file_catalog(&graph, root);
            }
            Ok(scanned)
        })
        .expect("stable catalog");

        assert_eq!(scans, 2);
        assert_eq!(
            catalog
                .notes
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["README.md", "arrived.md"]
        );
    }

    #[test]
    fn invalidation_identity_is_generation_pinned_for_event_consumers() {
        let vault = tempfile::tempdir().expect("vault");
        let old_vault = tempfile::tempdir().expect("old vault");
        let graph = GraphState(Mutex::new(GraphInner {
            generation: 11,
            root: Some(vault.path().to_path_buf()),
            root_capability: None,
            catalog: None,
            catalog_revision: 0,
        }));

        assert_eq!(
            invalidate_file_catalog_generation(&graph, old_vault.path()),
            None
        );
        assert_eq!(
            invalidate_file_catalog_generation(&graph, vault.path()),
            Some(11)
        );
        assert_eq!(
            serde_json::to_value(FileCatalogChanged { generation: 11 }).expect("serialize"),
            json!({ "generation": 11 })
        );
    }
}

#[cfg(all(test, desktop))]
mod graph_delete_identity_tests {
    use super::{
        invalidate_graph_for_delete, stage_graph_root_for_delete_with, trash_pinned_graph_root,
        GraphInner, GraphState,
    };
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use std::fs;
    use std::sync::{Arc, Mutex};

    fn graph_state(root: &std::path::Path, generation: u64) -> GraphState {
        GraphState(Mutex::new(GraphInner {
            generation,
            root: Some(root.to_path_buf()),
            root_capability: Some(Arc::new(
                Dir::open_ambient_dir(root, ambient_authority()).expect("root capability"),
            )),
            catalog: None,
            catalog_revision: 0,
        }))
    }

    #[test]
    fn graph_delete_rejects_a_root_renamed_after_session_invalidation() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("vault");
        let moved = parent.path().join("moved-vault");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("README.md"), "original\n").unwrap();
        let graph = graph_state(&root, 4);
        let pinned = invalidate_graph_for_delete(&graph, 4).unwrap();

        fs::rename(&root, &moved).unwrap();

        assert!(matches!(
            trash_pinned_graph_root(pinned),
            Err(crate::error::AppError::Traversal { .. })
        ));
        assert_eq!(
            fs::read_to_string(moved.join("README.md")).unwrap(),
            "original\n"
        );
        let inner = graph.0.lock().unwrap();
        assert!(inner.root.is_none());
        assert!(inner.root_capability.is_none());
        assert_eq!(inner.generation, 5);
    }

    #[test]
    fn graph_delete_rejects_a_replacement_at_the_selected_root_path() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("vault");
        let moved = parent.path().join("moved-vault");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("README.md"), "original\n").unwrap();
        let graph = graph_state(&root, 8);
        let pinned = invalidate_graph_for_delete(&graph, 8).unwrap();

        fs::rename(&root, &moved).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("README.md"), "replacement\n").unwrap();

        assert!(matches!(
            trash_pinned_graph_root(pinned),
            Err(crate::error::AppError::Traversal { .. })
        ));
        assert_eq!(
            fs::read_to_string(moved.join("README.md")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "replacement\n"
        );
    }

    #[test]
    fn delete_staging_restores_a_replacement_that_arrives_after_root_release() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("vault");
        let moved = parent.path().join("moved-vault");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("README.md"), "original\n").unwrap();
        let graph = graph_state(&root, 12);
        let pinned = invalidate_graph_for_delete(&graph, 12).unwrap();

        let result = stage_graph_root_for_delete_with(pinned, || {
            fs::rename(&root, &moved).unwrap();
            fs::create_dir(&root).unwrap();
            fs::write(root.join("README.md"), "replacement\n").unwrap();
        });

        assert!(matches!(
            result,
            Err(crate::error::AppError::Traversal { .. })
        ));
        assert_eq!(
            fs::read_to_string(moved.join("README.md")).unwrap(),
            "original\n"
        );
        assert_eq!(
            fs::read_to_string(root.join("README.md")).unwrap(),
            "replacement\n"
        );
        assert!(fs::read_dir(parent.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".reflect-delete-stage-")));
    }

    #[test]
    fn delete_staging_rejects_a_root_moved_after_capability_release() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("vault");
        let moved = parent.path().join("moved-vault");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("README.md"), "original\n").unwrap();
        let graph = graph_state(&root, 14);
        let pinned = invalidate_graph_for_delete(&graph, 14).unwrap();

        let result = stage_graph_root_for_delete_with(pinned, || {
            fs::rename(&root, &moved).unwrap();
        });

        assert!(matches!(
            result,
            Err(crate::error::AppError::Traversal { .. })
        ));
        assert_eq!(
            fs::read_to_string(moved.join("README.md")).unwrap(),
            "original\n"
        );
        assert!(!root.exists());
        assert!(fs::read_dir(parent.path()).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".reflect-delete-stage-")));
    }
}

#[cfg(test)]
mod move_tests {
    use super::{asset_file_url, move_note_file, PinnedGraphRoot};
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;
    use std::fs;
    use std::sync::Arc;

    fn graph() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("notes")).unwrap();
        dir
    }

    fn pinned(root: &std::path::Path) -> PinnedGraphRoot {
        PinnedGraphRoot {
            path: root.to_path_buf(),
            capability: Arc::new(
                Dir::open_ambient_dir(root, ambient_authority()).expect("root capability"),
            ),
        }
    }

    #[test]
    fn renames_when_the_destination_is_free() {
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# A\n").unwrap();
        move_note_file(&pinned(root.path()), "notes/a.md", "notes/b.md").unwrap();
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
        assert!(move_note_file(&pinned(root.path()), "notes/a.md", "notes/b.md").is_err());
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
        assert!(move_note_file(&pinned(root.path()), "notes/a.md", "notes/b.md").is_err());
        assert!(root.path().join("notes/a.md").exists());
    }

    #[test]
    fn note_moves_reject_hidden_reserved_and_non_markdown_paths() {
        let root = graph();
        fs::write(root.path().join("notes/a.md"), "# Mine\n").unwrap();
        let pinned = pinned(root.path());
        for destination in [".git/config", "assets/a.md", ".hidden.md", "notes/a.txt"] {
            assert!(move_note_file(&pinned, "notes/a.md", destination).is_err());
            assert!(root.path().join("notes/a.md").exists());
        }
        assert!(move_note_file(&pinned, ".hidden.md", "notes/b.md").is_err());
    }

    #[test]
    fn asset_file_url_percent_encodes_local_paths() {
        let path = std::env::temp_dir().join("Reflect Cat Photo.png");
        let url = asset_file_url(&path).unwrap();

        assert_eq!(url.scheme(), "file");
        assert!(url.as_str().contains("Reflect%20Cat%20Photo.png"));
    }
}
