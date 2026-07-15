//! Filesystem watcher for the open graph (Plan 04b).
//!
//! A debounced `notify` watcher over the graph root. It's the **sole** trigger
//! for incremental re-indexing: an edit (ours or external) writes the markdown
//! file, the watcher fires, and the frontend re-indexes that file. The index
//! lives under `.reflect/`, which is filtered out here, so index writes can't
//! loop back. The watcher reports eligible `.md` anywhere in the graph plus
//! supported local attachments, recordings under `audio-memos/`, and capture
//! inbox envelopes. Non-note consumers filter by path; imported attachments
//! outside Reflect's managed `assets/` tree never enter the AI description
//! pipeline. The frontend resolves
//! create-vs-delete and re-indexes (content-hash gated).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU8, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

/// The Tauri event name carrying batched {@link FileChange}s to the frontend.
const CHANGE_EVENT: &str = "index:changed";
const RETRY_IDLE: u8 = 0;
const RETRY_RUNNING: u8 = 1;
const RETRY_PENDING: u8 = 2;

fn request_catalog_retry(retry_state: &AtomicU8) -> bool {
    loop {
        match retry_state.load(Ordering::Acquire) {
            RETRY_IDLE => {
                if retry_state
                    .compare_exchange(
                        RETRY_IDLE,
                        RETRY_RUNNING,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
                {
                    return true;
                }
            }
            RETRY_RUNNING => {
                if retry_state
                    .compare_exchange(
                        RETRY_RUNNING,
                        RETRY_PENDING,
                        Ordering::AcqRel,
                        Ordering::Acquire,
                    )
                    .is_ok()
                {
                    return false;
                }
                // Completion may have released RUNNING between the load and
                // CAS. Re-read so this request can claim the now-idle slot.
            }
            RETRY_PENDING => return false,
            invalid => {
                tracing::error!(invalid, "invalid watcher retry state");
                return false;
            }
        }
    }
}

/// Release the running slot after success, or consume a request that arrived
/// while the traversal was finishing and keep the same task alive for it.
fn complete_catalog_retry(retry_state: &AtomicU8) -> bool {
    match retry_state.compare_exchange(
        RETRY_RUNNING,
        RETRY_IDLE,
        Ordering::AcqRel,
        Ordering::Acquire,
    ) {
        Ok(_) => false,
        Err(RETRY_PENDING) => {
            retry_state.store(RETRY_RUNNING, Ordering::Release);
            true
        }
        Err(invalid) => {
            tracing::error!(invalid, "invalid watcher retry completion state");
            false
        }
    }
}

/// Holds the active debouncer; dropping it stops the background watch thread.
#[derive(Default)]
pub struct WatcherState(Mutex<Option<ActiveWatcher>>);

struct ActiveWatcher {
    debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    active: Arc<AtomicBool>,
}

impl Drop for ActiveWatcher {
    fn drop(&mut self) {
        self.active.store(false, Ordering::Release);
    }
}

/// A debounced change to a tracked markdown note, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    /// `"upsert"` (created/modified) or `"remove"` (deleted).
    pub kind: String,
    /// Last-modified time in epoch milliseconds, set for upserts. The frontend
    /// stamps `notes.mtime` from this — without it, watcher-indexed rows would
    /// carry no real timestamp (and reconcile would never repair them, since it
    /// is content-hash gated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CatalogEntry {
    size: u64,
    modified_ms: u64,
    placeholder: bool,
}

type CatalogSnapshot = BTreeMap<String, CatalogEntry>;

fn catalog_snapshot(files: Vec<crate::fs::FileMeta>) -> CatalogSnapshot {
    files
        .into_iter()
        .map(|file| {
            (
                file.path,
                CatalogEntry {
                    size: file.size,
                    modified_ms: file.modified_ms,
                    placeholder: file.placeholder,
                },
            )
        })
        .collect()
}

fn scan_catalog(root: &Path) -> AppResult<CatalogSnapshot> {
    Ok(catalog_snapshot(crate::fs::catalog_files(root)?))
}

/// Compare two complete manifests. A placeholder is still present but cannot
/// be read, so an eviction never becomes an upsert or remove; a later
/// materialization does become an upsert.
fn diff_catalogs(before: &CatalogSnapshot, after: &CatalogSnapshot) -> Vec<FileChange> {
    let mut changes = Vec::new();
    for path in before.keys().chain(after.keys()) {
        let previous = before.get(path);
        let current = after.get(path);
        let change = match (previous, current) {
            (Some(_), None) => Some(FileChange {
                path: path.clone(),
                kind: "remove".to_string(),
                modified_ms: None,
            }),
            (None, Some(current)) if !current.placeholder => Some(FileChange {
                path: path.clone(),
                kind: "upsert".to_string(),
                modified_ms: Some(current.modified_ms),
            }),
            (Some(previous), Some(current)) if !current.placeholder && previous != current => {
                Some(FileChange {
                    path: path.clone(),
                    kind: "upsert".to_string(),
                    modified_ms: Some(current.modified_ms),
                })
            }
            _ => None,
        };
        if let Some(change) = change {
            changes.push(change);
        }
    }
    changes.sort_by(|left, right| left.path.cmp(&right.path));
    changes.dedup_by(|left, right| left.path == right.path);
    changes
}

/// Graph-relative path if `path` is tracked: a markdown note (`.md` under
/// any visible non-reserved tree), an audio-memo recording (anything under
/// `audio-memos/`), a spooled capture envelope (`.json` under `.reflect/inbox/`
/// — the one carve-out from the `.reflect/` blackout; the envelope is the
/// spool's commit point and triggers the capture drain), or a supported local
/// attachment anywhere in the graph,
/// else `None`. Pure — the filtering rule, unit-tested.
fn tracked_relpath(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    // An iCloud eviction placeholder tracks as the file it stands in for —
    // eviction/re-download events must never read as a stub appearing or the
    // note being deleted (Plan 21).
    let rel_str = reflect_graph_paths::evicted_logical_path(Path::new(&rel_str))
        .map(|logical| logical.to_string_lossy().replace('\\', "/"))
        .unwrap_or(rel_str);
    let kind = reflect_graph_paths::classify_normalized(&rel_str);
    let note = kind == Some(reflect_graph_paths::GraphPathKind::Note);
    let recording = rel_str.starts_with("audio-memos/")
        && reflect_graph_paths::is_safe_visible_relative(Path::new(&rel_str));
    let capture = rel_str.starts_with(".reflect/inbox/") && rel_str.ends_with(".json");
    let attachment = kind == Some(reflect_graph_paths::GraphPathKind::Attachment);
    (note || recording || capture || attachment).then_some(rel_str)
}

/// Reduce a debounced batch of paths to unique tracked changes (last kind wins).
/// Create/modify vs delete is decided by whether the file currently stats; the
/// same stat supplies the upsert's `modified_ms`. A file that is gone but has
/// an eviction placeholder in its place was offloaded by iCloud, not deleted:
/// no event — the index keeps its last-known content until re-download.
fn collect_changes(paths: &[PathBuf], root: &Path) -> Vec<FileChange> {
    let mut seen: std::collections::BTreeMap<String, FileChange> =
        std::collections::BTreeMap::new();
    for path in paths {
        if let Some(rel) = tracked_relpath(path, root) {
            // Stat the *logical* path — for placeholder events it differs
            // from the event path, and it is what consumers read.
            let logical = root.join(&rel);
            let change = if path_has_symlink(root, Path::new(&rel)) {
                // A previously indexed file can be replaced by a symlink.
                // Emit a removal rather than silently keeping the stale row;
                // never stat through the link or any linked parent directory.
                FileChange {
                    path: rel.clone(),
                    kind: "remove".to_string(),
                    modified_ms: None,
                }
            } else {
                match std::fs::metadata(&logical) {
                    Ok(meta) if meta.is_file() => FileChange {
                        path: rel.clone(),
                        kind: "upsert".to_string(),
                        modified_ms: crate::fs::modified_ms(&meta),
                    },
                    Ok(_) => FileChange {
                        path: rel.clone(),
                        kind: "remove".to_string(),
                        modified_ms: None,
                    },
                    Err(_) => {
                        if crate::fs::eviction_placeholder(&logical).is_some_and(|stub| {
                            std::fs::symlink_metadata(stub)
                                .is_ok_and(|metadata| metadata.file_type().is_file())
                        }) {
                            continue; // evicted, not deleted
                        }
                        FileChange {
                            path: rel.clone(),
                            kind: "remove".to_string(),
                            modified_ms: None,
                        }
                    }
                }
            };
            seen.insert(rel, change);
        }
    }
    seen.into_values().collect()
}

/// Whether any existing component of a graph-relative path is a symlink.
/// `symlink_metadata` examines the link itself; checking every component keeps
/// a child event under a symlinked directory from reaching its target.
fn path_has_symlink(root: &Path, rel: &Path) -> bool {
    let mut current = root.to_path_buf();
    for component in rel.components() {
        current.push(component.as_os_str());
        match std::fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return false,
            Err(_) => return true,
        }
    }
    false
}

fn may_affect_catalog(path: &Path, root: &Path) -> bool {
    tracked_relpath(path, root)
        .is_some_and(|relative| reflect_graph_paths::classify_normalized(&relative).is_some())
}

fn reports_attachment_change(changes: &[FileChange]) -> bool {
    changes.iter().any(|change| {
        reflect_graph_paths::classify_normalized(&change.path)
            == Some(reflect_graph_paths::GraphPathKind::Attachment)
    })
}

fn has_catalog_descendant(snapshot: &CatalogSnapshot, relative: &str) -> bool {
    let prefix = format!("{relative}/");
    snapshot.keys().any(|path| path.starts_with(&prefix))
}

/// Directory rename/remove notifications are not guaranteed to enumerate
/// their descendants. Detect those events from the current file type or the
/// previous manifest and fall back to one full manifest delta.
fn needs_catalog_diff(paths: &[PathBuf], root: &Path, snapshot: &CatalogSnapshot) -> bool {
    paths.iter().any(|path| {
        let Ok(relative) = path.strip_prefix(root) else {
            return false;
        };
        if relative.as_os_str().is_empty() {
            return false;
        }
        let relative_string = relative.to_string_lossy().replace('\\', "/");
        if has_catalog_descendant(snapshot, &relative_string) {
            return true;
        }
        std::fs::symlink_metadata(path).is_ok_and(|metadata| {
            metadata.file_type().is_dir() && reflect_graph_paths::is_safe_visible_relative(relative)
        })
    })
}

fn apply_changes_to_snapshot(snapshot: &mut CatalogSnapshot, changes: &[FileChange], root: &Path) {
    for change in changes {
        if reflect_graph_paths::classify_normalized(&change.path).is_none() {
            continue;
        }
        if change.kind == "remove" {
            snapshot.remove(&change.path);
            continue;
        }
        let relative = Path::new(&change.path);
        if path_has_symlink(root, relative) {
            snapshot.remove(&change.path);
            continue;
        }
        let Ok(metadata) = std::fs::metadata(root.join(relative)) else {
            snapshot.remove(&change.path);
            continue;
        };
        if !metadata.is_file() {
            snapshot.remove(&change.path);
            continue;
        }
        snapshot.insert(
            change.path.clone(),
            CatalogEntry {
                size: metadata.len(),
                modified_ms: change
                    .modified_ms
                    .or_else(|| crate::fs::modified_ms(&metadata))
                    .unwrap_or(0),
                placeholder: false,
            },
        );
    }
}

fn merge_changes(primary: Vec<FileChange>, authoritative: Vec<FileChange>) -> Vec<FileChange> {
    let mut merged: BTreeMap<String, FileChange> = primary
        .into_iter()
        .map(|change| (change.path.clone(), change))
        .collect();
    for change in authoritative {
        merged.insert(change.path.clone(), change);
    }
    merged.into_values().collect()
}

/// Re-scan and replace a watcher manifest while holding the same lock every
/// live callback uses. Keeping the lock across `scan` is load-bearing: a
/// callback must either land wholly before this snapshot or wholly after it,
/// never update the map only to be overwritten by an older scan result.
fn catch_up_catalog_with<F>(
    snapshot: &Mutex<CatalogSnapshot>,
    scan: F,
) -> AppResult<(Vec<FileChange>, bool)>
where
    F: FnOnce() -> AppResult<CatalogSnapshot>,
{
    let mut snapshot = snapshot.lock().map_err(|error| {
        tracing::error!(?error, "watcher catalog snapshot lock poisoned");
        AppError::io("watcher catalog snapshot lock poisoned")
    })?;
    let after = scan()?;
    let changed = *snapshot != after;
    let changes = diff_catalogs(&snapshot, &after);
    *snapshot = after;
    Ok((changes, changed))
}

/// Retry a failed authoritative traversal until it succeeds or this graph is
/// no longer active. Directory notifications can omit descendants, so keeping
/// only their leaf events after a transient scan failure would leave the
/// projection stale indefinitely when no later filesystem event arrives.
fn schedule_catalog_retry(
    app: AppHandle,
    root: PathBuf,
    generation: u64,
    snapshot: Arc<Mutex<CatalogSnapshot>>,
    retry_state: Arc<AtomicU8>,
    watcher_active: Arc<AtomicBool>,
) {
    if !watcher_active.load(Ordering::Acquire) {
        return;
    }

    if !request_catalog_retry(&retry_state) {
        return;
    }

    tauri::async_runtime::spawn(async move {
        let mut delay = Duration::from_millis(250);
        loop {
            tokio::time::sleep(delay).await;

            if !watcher_active.load(Ordering::Acquire) {
                retry_state.store(RETRY_IDLE, Ordering::Release);
                break;
            }

            let active_root =
                crate::fs::root_for_generation(&app.state::<GraphState>(), generation);
            if !matches!(active_root, Ok(active_root) if active_root == root) {
                watcher_active.store(false, Ordering::Release);
                retry_state.store(RETRY_IDLE, Ordering::Release);
                break;
            }

            let retry_root = root.clone();
            let retry_snapshot = Arc::clone(&snapshot);
            let outcome = tauri::async_runtime::spawn_blocking(move || {
                catch_up_catalog_with(retry_snapshot.as_ref(), || scan_catalog(&retry_root))
            })
            .await;

            match outcome {
                Ok(Ok((changes, catalog_changed))) => {
                    if !watcher_active.load(Ordering::Acquire) {
                        retry_state.store(RETRY_IDLE, Ordering::Release);
                        break;
                    }
                    let active_root =
                        crate::fs::root_for_generation(&app.state::<GraphState>(), generation);
                    if !matches!(active_root, Ok(active_root) if active_root == root) {
                        watcher_active.store(false, Ordering::Release);
                        retry_state.store(RETRY_IDLE, Ordering::Release);
                        break;
                    }
                    if catalog_changed {
                        let graph = app.state::<GraphState>();
                        if reports_attachment_change(&changes) {
                            crate::fs::invalidate_file_catalog(&graph, &root);
                        } else {
                            crate::fs::invalidate_file_catalog_and_emit(&app, &graph, &root);
                        }
                    }
                    if !changes.is_empty() {
                        let _ = app.emit(CHANGE_EVENT, changes);
                    }
                    if complete_catalog_retry(&retry_state) {
                        delay = Duration::from_millis(250);
                        continue;
                    }
                    break;
                }
                Ok(Err(error)) => {
                    tracing::warn!(?error, "failed to retry graph file catalog reconciliation")
                }
                Err(error) => {
                    tracing::error!(?error, "graph file catalog reconciliation task panicked")
                }
            }

            let _ = retry_state.compare_exchange(
                RETRY_PENDING,
                RETRY_RUNNING,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            delay = std::cmp::min(delay.saturating_mul(2), Duration::from_secs(5));
        }
    });
}

fn lock_watcher<'a>(
    watcher: &'a State<WatcherState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<ActiveWatcher>>> {
    watcher.0.lock().map_err(|err| {
        tracing::error!(?err, "watcher state lock poisoned by an earlier panic");
        AppError::io("watcher state lock poisoned")
    })
}

/// Start (or restart) watching the active graph; emits `index:changed` batches.
///
/// The graph lock is held from reading the root until the new debouncer is
/// installed, so a concurrent `graph_open` can't swap the root mid-install and
/// leave a watcher bound to the previous graph emitting events attributed to
/// the new one. Lock order is graph → watcher; nothing locks the reverse way,
/// so this can't deadlock.
#[tauri::command]
pub fn watch_start(
    app: AppHandle,
    graph: State<GraphState>,
    watcher: State<WatcherState>,
) -> AppResult<()> {
    let (root, generation, catalog_files) = crate::fs::current_catalog_files(&graph)?;
    let snapshot = Arc::new(Mutex::new(catalog_snapshot(catalog_files)));
    let graph_guard = graph.0.lock().map_err(|err| {
        tracing::error!(?err, "graph state lock poisoned by an earlier panic");
        AppError::io("graph state lock poisoned")
    })?;
    if graph_guard.generation != generation || graph_guard.root.as_deref() != Some(root.as_path()) {
        return Err(AppError::io(
            "the graph changed while its watcher was starting; dropping it",
        ));
    }

    // Drop any previous watcher first: if installing the new one fails we're then
    // left with no watcher, rather than the previous graph's still driving
    // index:changed against the now-current graph.
    *lock_watcher(&watcher)? = None;

    let handler_root = root.clone();
    let handler_snapshot = Arc::clone(&snapshot);
    let retry_state = Arc::new(AtomicU8::new(RETRY_IDLE));
    let handler_retry_state = Arc::clone(&retry_state);
    let watcher_active = Arc::new(AtomicBool::new(true));
    let handler_watcher_active = Arc::clone(&watcher_active);
    let handler_app = app.clone();
    let debouncer = new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else {
                schedule_catalog_retry(
                    handler_app.clone(),
                    handler_root.clone(),
                    generation,
                    Arc::clone(&handler_snapshot),
                    Arc::clone(&handler_retry_state),
                    Arc::clone(&handler_watcher_active),
                );
                return;
            };
            let paths: Vec<PathBuf> = events
                .iter()
                .flat_map(|event| event.paths.clone())
                .collect();
            let (changes, needs_diff, retry_catalog) = match handler_snapshot.lock() {
                Ok(mut snapshot) => {
                    let mut changes = collect_changes(&paths, &handler_root);
                    let needs_diff = needs_catalog_diff(&paths, &handler_root, &snapshot);
                    let mut retry_catalog = false;
                    if needs_diff {
                        match scan_catalog(&handler_root) {
                            Ok(after) => {
                                let manifest_changes = diff_catalogs(&snapshot, &after);
                                *snapshot = after;
                                changes = merge_changes(changes, manifest_changes);
                            }
                            Err(error) => {
                                tracing::warn!(
                                    ?error,
                                    "failed to rebuild graph file catalog after directory change"
                                );
                                apply_changes_to_snapshot(&mut snapshot, &changes, &handler_root);
                                retry_catalog = true;
                            }
                        }
                    } else {
                        apply_changes_to_snapshot(&mut snapshot, &changes, &handler_root);
                    }
                    (changes, needs_diff, retry_catalog)
                }
                Err(error) => {
                    tracing::error!(?error, "watcher catalog snapshot lock poisoned");
                    return;
                }
            };
            if retry_catalog {
                schedule_catalog_retry(
                    handler_app.clone(),
                    handler_root.clone(),
                    generation,
                    Arc::clone(&handler_snapshot),
                    Arc::clone(&handler_retry_state),
                    Arc::clone(&handler_watcher_active),
                );
            }
            if needs_diff
                || paths
                    .iter()
                    .any(|path| may_affect_catalog(path, &handler_root))
            {
                let graph = handler_app.state::<GraphState>();
                let attachment_refresh_needed = !reports_attachment_change(&changes)
                    && (needs_diff
                        || paths.iter().any(|path| {
                            tracked_relpath(path, &handler_root).is_some_and(|relative| {
                                reflect_graph_paths::classify_normalized(&relative)
                                    == Some(reflect_graph_paths::GraphPathKind::Attachment)
                            })
                        }));
                if attachment_refresh_needed {
                    crate::fs::invalidate_file_catalog_and_emit(
                        &handler_app,
                        &graph,
                        &handler_root,
                    );
                } else {
                    crate::fs::invalidate_file_catalog(&graph, &handler_root);
                }
            }
            if !changes.is_empty() {
                let _ = handler_app.emit(CHANGE_EVENT, changes);
            }
        },
    )
    .map_err(|err| AppError::io(err.to_string()))?;

    let mut active_watcher = ActiveWatcher {
        debouncer,
        active: watcher_active,
    };

    active_watcher
        .debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| AppError::io(err.to_string()))?;

    // Close the snapshot→watch-install race: once the watcher is live, scan
    // once more. Any later write is covered by the watcher; anything that
    // landed in the small install gap is emitted from this manifest delta.
    let (catch_up, catalog_changed) =
        catch_up_catalog_with(snapshot.as_ref(), || scan_catalog(&root))?;
    // Dropping any previous debouncer here stops its thread.
    *lock_watcher(&watcher)? = Some(active_watcher);
    drop(graph_guard);
    if catalog_changed {
        if reports_attachment_change(&catch_up) {
            crate::fs::invalidate_file_catalog(&graph, &root);
        } else {
            crate::fs::invalidate_file_catalog_and_emit(&app, &graph, &root);
        }
    }
    if !catch_up.is_empty() {
        let _ = app.emit(CHANGE_EVENT, catch_up);
    }
    Ok(())
}

/// Stop watching (drops the debouncer).
#[tauri::command]
pub fn watch_stop(watcher: State<WatcherState>) -> AppResult<()> {
    *lock_watcher(&watcher)? = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracks_arbitrary_visible_markdown_and_audio_memo_recordings() {
        let root = Path::new("/g");
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/a.md"), root).as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/daily/2026-06-09.md"), root).as_deref(),
            Some("daily/2026-06-09.md")
        );
        // Templates are tracked like notes; only `.md` files count.
        assert_eq!(
            tracked_relpath(Path::new("/g/templates/journal.md"), root).as_deref(),
            Some("templates/journal.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/templates/journal.txt"), root),
            None
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/README.md"), root).as_deref(),
            Some("README.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/deep/plan.md"), root).as_deref(),
            Some("Projects/deep/plan.md")
        );
        // Recordings are tracked whole-directory: they feed the sync debounce
        // and the transcription reconciler.
        assert_eq!(
            tracked_relpath(
                Path::new("/g/audio-memos/audio-memo-2026-06-09-090000-000.m4a"),
                root
            )
            .as_deref(),
            Some("audio-memos/audio-memo-2026-06-09-090000-000.m4a")
        );
        // Capture envelopes are tracked: `.json` under `.reflect/inbox/` is
        // the spool's commit point and triggers the drain. Sibling screenshots
        // and host tmp files are not.
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox/7c9e6679.json"), root).as_deref(),
            Some(".reflect/inbox/7c9e6679.json")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox/7c9e6679.jpg"), root),
            None
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox/.tmp-x8f2"), root),
            None
        );
        // Quarantined spools must not re-trigger the drain.
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/inbox-rejected/bad.json"), root),
            None
        );
        // Not tracked: the index, non-markdown, dotfiles, outside root, or the
        // audio-memos directory entry itself. (Eligible assets ARE tracked — see
        // the dedicated test below.)
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/index.sqlite"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/g/notes/x.txt"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/.hidden/a.md"), root), None);
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/.hidden.md"), root),
            None
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/assets/caption.md"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/g/audio-memos"), root), None);
        assert_eq!(
            tracked_relpath(Path::new("/g/audio-memos/.hidden.m4a"), root),
            None
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/audio-memos/.private/memo.m4a"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/other/notes/a.md"), root), None);
    }

    #[test]
    fn tracks_supported_attachments_anywhere_but_not_hidden_or_other_files() {
        let root = Path::new("/g");
        for ext in reflect_graph_paths::ATTACHMENT_EXTENSIONS {
            let path = format!("/g/assets/diagram.{ext}");
            let expected = format!("assets/diagram.{ext}");
            assert_eq!(
                tracked_relpath(Path::new(&path), root).as_deref(),
                Some(expected.as_str())
            );
        }
        // Extension match is case-insensitive.
        assert_eq!(
            tracked_relpath(Path::new("/g/assets/PHOTO.PNG"), root).as_deref(),
            Some("assets/PHOTO.PNG")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/diagram.png"), root).as_deref(),
            Some("Projects/diagram.png")
        );
        // The description file lives under assets/ too — tracking it would loop a
        // write back into the controller, so it must never be tracked.
        assert_eq!(
            tracked_relpath(Path::new("/g/assets/diagram.png.reflect.md"), root),
            None
        );
        // Ineligible types and stray markdown under assets/ are not tracked.
        assert_eq!(tracked_relpath(Path::new("/g/assets/data.txt"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/assets/notes.md"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/assets/noext"), root), None);
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/.private/diagram.png"), root),
            None
        );
    }

    #[test]
    fn collect_changes_dedupes_and_marks_missing_as_remove() {
        let root = Path::new("/g");
        // These paths don't exist on disk → "remove"; deduped by path.
        let changes = collect_changes(
            &[
                PathBuf::from("/g/notes/a.md"),
                PathBuf::from("/g/notes/a.md"),
                PathBuf::from("/g/.reflect/index.sqlite"),
            ],
            root,
        );
        assert_eq!(
            changes,
            vec![FileChange {
                path: "notes/a.md".to_string(),
                kind: "remove".to_string(),
                modified_ms: None,
            }]
        );
    }

    #[test]
    fn collect_changes_stamps_upserts_with_the_file_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let note = root.join("notes/a.md");
        std::fs::write(&note, "# a").unwrap();

        let changes = collect_changes(&[note], root);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "notes/a.md");
        assert_eq!(changes[0].kind, "upsert");
        // A real timestamp, not epoch zero — All Notes sorts and labels by it.
        assert!(changes[0].modified_ms.is_some_and(|ms| ms > 0));
    }

    #[test]
    fn directory_rename_emits_a_manifest_delta_for_descendant_notes() {
        let graph = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(graph.path().join("Projects/deep")).unwrap();
        std::fs::write(graph.path().join("Projects/deep/plan.md"), "# Plan\n").unwrap();
        let before = scan_catalog(graph.path()).unwrap();

        std::fs::rename(graph.path().join("Projects"), graph.path().join("Archive")).unwrap();
        let paths = [graph.path().join("Projects"), graph.path().join("Archive")];
        assert!(needs_catalog_diff(&paths, graph.path(), &before));

        let after = scan_catalog(graph.path()).unwrap();
        let shapes: Vec<(String, String)> = diff_catalogs(&before, &after)
            .into_iter()
            .map(|change| (change.path, change.kind))
            .collect();
        assert_eq!(
            shapes,
            vec![
                ("Archive/deep/plan.md".to_string(), "upsert".to_string()),
                ("Projects/deep/plan.md".to_string(), "remove".to_string()),
            ]
        );
    }

    #[test]
    fn catch_up_scan_cannot_overwrite_a_callback_that_observed_a_later_file() {
        use std::sync::mpsc;

        let graph = tempfile::tempdir().unwrap();
        let snapshot = Arc::new(Mutex::new(CatalogSnapshot::new()));
        let (scan_started_tx, scan_started_rx) = mpsc::channel();
        let (finish_scan_tx, finish_scan_rx) = mpsc::channel();

        let catch_up_snapshot = Arc::clone(&snapshot);
        let catch_up = std::thread::spawn(move || {
            catch_up_catalog_with(catch_up_snapshot.as_ref(), || {
                scan_started_tx.send(()).unwrap();
                finish_scan_rx.recv().unwrap();
                // Simulate a traversal that passed the note's directory just
                // before the file was created.
                Ok(CatalogSnapshot::new())
            })
        });
        scan_started_rx.recv().unwrap();

        let late_note = graph.path().join("late.md");
        std::fs::write(&late_note, "# Late\n").unwrap();
        let root = graph.path().to_path_buf();
        let callback_snapshot = Arc::clone(&snapshot);
        let (callback_attempted_tx, callback_attempted_rx) = mpsc::channel();
        let (callback_done_tx, callback_done_rx) = mpsc::channel();
        let callback = std::thread::spawn(move || {
            callback_attempted_tx.send(()).unwrap();
            let mut snapshot = callback_snapshot.lock().unwrap();
            apply_changes_to_snapshot(
                &mut snapshot,
                &[FileChange {
                    path: "late.md".to_string(),
                    kind: "upsert".to_string(),
                    modified_ms: None,
                }],
                &root,
            );
            callback_done_tx.send(()).unwrap();
        });
        callback_attempted_rx.recv().unwrap();
        assert!(
            callback_done_rx
                .recv_timeout(std::time::Duration::from_millis(50))
                .is_err(),
            "callback updated the snapshot while catch-up was still scanning"
        );

        finish_scan_tx.send(()).unwrap();
        let (catch_up_changes, changed) = catch_up.join().unwrap().unwrap();
        callback.join().unwrap();

        assert!(catch_up_changes.is_empty());
        assert!(!changed);
        assert!(snapshot.lock().unwrap().contains_key("late.md"));
    }

    #[test]
    fn failed_catalog_scan_keeps_the_last_complete_snapshot() {
        let mut before = CatalogSnapshot::new();
        before.insert(
            "Projects/plan.md".to_string(),
            CatalogEntry {
                size: 12,
                modified_ms: 34,
                placeholder: false,
            },
        );
        let snapshot = Mutex::new(before.clone());

        let result = catch_up_catalog_with(&snapshot, || {
            Err(AppError::io("transient traversal failure"))
        });

        assert!(result.is_err());
        assert_eq!(*snapshot.lock().unwrap(), before);
    }

    #[test]
    fn retry_requested_while_a_scan_finishes_is_not_lost() {
        let retry_state = AtomicU8::new(RETRY_RUNNING);

        assert!(!request_catalog_retry(&retry_state));
        assert_eq!(retry_state.load(Ordering::Acquire), RETRY_PENDING);
        assert!(complete_catalog_retry(&retry_state));
        assert_eq!(retry_state.load(Ordering::Acquire), RETRY_RUNNING);

        assert!(!complete_catalog_retry(&retry_state));
        assert_eq!(retry_state.load(Ordering::Acquire), RETRY_IDLE);
        assert!(request_catalog_retry(&retry_state));
        assert_eq!(retry_state.load(Ordering::Acquire), RETRY_RUNNING);
    }

    #[test]
    fn catalog_delta_keeps_evictions_silent_and_upserts_materialization() {
        let graph = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(graph.path().join("Projects")).unwrap();
        let note = graph.path().join("Projects/plan.md");
        let placeholder = graph.path().join("Projects/.plan.md.icloud");
        std::fs::write(&note, "# Plan\n").unwrap();
        let present = scan_catalog(graph.path()).unwrap();

        std::fs::remove_file(&note).unwrap();
        std::fs::write(&placeholder, "stub").unwrap();
        let evicted = scan_catalog(graph.path()).unwrap();
        assert!(diff_catalogs(&present, &evicted).is_empty());

        std::fs::write(&note, "# Downloaded\n").unwrap();
        let materialized = scan_catalog(graph.path()).unwrap();
        let changes = diff_catalogs(&evicted, &materialized);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "Projects/plan.md");
        assert_eq!(changes[0].kind, "upsert");
    }

    #[test]
    fn a_directory_named_like_a_note_is_never_upserted_as_a_file() {
        let graph = tempfile::tempdir().unwrap();
        let directory = graph.path().join("folder.md");
        std::fs::create_dir(&directory).unwrap();

        assert_eq!(
            collect_changes(std::slice::from_ref(&directory), graph.path()),
            vec![FileChange {
                path: "folder.md".to_string(),
                kind: "remove".to_string(),
                modified_ms: None,
            }]
        );
        assert!(needs_catalog_diff(
            std::slice::from_ref(&directory),
            graph.path(),
            &CatalogSnapshot::new(),
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_files_and_descendants_emit_removals_without_following_targets() {
        use std::os::unix::fs::symlink;

        let graph = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("secret.md"), "outside").unwrap();
        symlink(
            outside.path().join("secret.md"),
            graph.path().join("linked.md"),
        )
        .unwrap();
        symlink(outside.path(), graph.path().join("linked-dir")).unwrap();

        let changes = collect_changes(
            &[
                graph.path().join("linked.md"),
                graph.path().join("linked-dir/secret.md"),
            ],
            graph.path(),
        );
        assert_eq!(
            changes,
            vec![
                FileChange {
                    path: "linked-dir/secret.md".to_string(),
                    kind: "remove".to_string(),
                    modified_ms: None,
                },
                FileChange {
                    path: "linked.md".to_string(),
                    kind: "remove".to_string(),
                    modified_ms: None,
                },
            ]
        );
    }

    #[test]
    fn placeholder_events_track_as_their_logical_catalog_path() {
        let root = Path::new("/g");
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/.a.md.icloud"), root).as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/audio-memos/.memo.m4a.icloud"), root).as_deref(),
            Some("audio-memos/memo.m4a")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/Media/.photo.png.icloud"), root).as_deref(),
            Some("Media/photo.png")
        );
        // The logical file must still pass the tracking rules.
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/.a.txt.icloud"), root),
            None
        );
    }

    #[test]
    fn eviction_emits_nothing_when_the_placeholder_is_present() {
        // iCloud offloaded the note: the file is gone but its `.icloud` stub
        // remains. That must not read as a deletion — the index keeps the
        // note's last-known content until re-download.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/.a.md.icloud"), b"stub").unwrap();

        // The debounced batch carries both the vanished note and the stub.
        let changes = collect_changes(
            &[root.join("notes/a.md"), root.join("notes/.a.md.icloud")],
            root,
        );
        assert!(changes.is_empty(), "eviction leaked events: {changes:?}");
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_eviction_placeholder_does_not_suppress_removal() {
        use std::os::unix::fs::symlink;

        let graph = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(graph.path().join("notes")).unwrap();
        std::fs::write(outside.path().join("stub"), b"outside").unwrap();
        symlink(
            outside.path().join("stub"),
            graph.path().join("notes/.a.md.icloud"),
        )
        .unwrap();

        assert_eq!(
            collect_changes(&[graph.path().join("notes/a.md")], graph.path()),
            vec![FileChange {
                path: "notes/a.md".to_string(),
                kind: "remove".to_string(),
                modified_ms: None,
            }]
        );
    }

    #[test]
    fn redownload_events_upsert_the_logical_note() {
        // Mid-download both the stub and the real file can exist; whichever
        // path the event carries, the change is an upsert of the note.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(root.join("notes/a.md"), "# a").unwrap();
        std::fs::write(root.join("notes/.a.md.icloud"), b"stub").unwrap();

        let changes = collect_changes(&[root.join("notes/.a.md.icloud")], root);
        assert_eq!(changes.len(), 1);
        assert_eq!(changes[0].path, "notes/a.md");
        assert_eq!(changes[0].kind, "upsert");
    }
}
