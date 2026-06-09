//! Filesystem watcher for the open graph (Plan 04b).
//!
//! A debounced `notify` watcher over the graph root. It's the **sole** trigger
//! for incremental re-indexing: an edit (ours or external) writes the markdown
//! file, the watcher fires, and the frontend re-indexes that file. The index
//! lives under `.reflect/`, which is filtered out here, so index writes can't
//! loop back. The watcher only reports `.md` under `daily/` and `notes/`; the
//! frontend resolves create-vs-delete and re-indexes (content-hash gated).

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

/// The Tauri event name carrying batched {@link FileChange}s to the frontend.
const CHANGE_EVENT: &str = "index:changed";

/// Holds the active debouncer; dropping it stops the background watch thread.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>);

/// A debounced change to a tracked markdown note, sent to the frontend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    /// `"upsert"` (created/modified) or `"remove"` (deleted).
    pub kind: String,
}

/// Graph-relative path if `path` is a tracked markdown note (`.md` under `daily/`
/// or `notes/`), else `None`. Pure — the filtering rule, unit-tested.
fn tracked_relpath(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    let tracked = (rel_str.starts_with("daily/") || rel_str.starts_with("notes/"))
        && rel_str.ends_with(".md");
    tracked.then_some(rel_str)
}

/// Reduce a debounced batch of paths to unique tracked changes (last kind wins).
/// Create/modify vs delete is decided by whether the file currently exists.
fn collect_changes(paths: &[PathBuf], root: &Path) -> Vec<FileChange> {
    let mut seen: std::collections::BTreeMap<String, FileChange> =
        std::collections::BTreeMap::new();
    for path in paths {
        if let Some(rel) = tracked_relpath(path, root) {
            let kind = if path.exists() { "upsert" } else { "remove" };
            seen.insert(
                rel.clone(),
                FileChange {
                    path: rel,
                    kind: kind.to_string(),
                },
            );
        }
    }
    seen.into_values().collect()
}

fn lock_watcher<'a>(
    watcher: &'a State<WatcherState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<Debouncer<RecommendedWatcher, RecommendedCache>>>> {
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
    let graph_guard = graph.0.lock().map_err(|err| {
        tracing::error!(?err, "graph state lock poisoned by an earlier panic");
        AppError::io("graph state lock poisoned")
    })?;
    let root = graph_guard.root.clone().ok_or_else(AppError::no_graph)?;

    // Drop any previous watcher first: if installing the new one fails we're then
    // left with no watcher, rather than the previous graph's still driving
    // index:changed against the now-current graph.
    *lock_watcher(&watcher)? = None;

    let handler_root = root.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else {
                return; // watch errors are transient; the next batch recovers
            };
            let paths: Vec<PathBuf> = events
                .iter()
                .flat_map(|event| event.paths.clone())
                .collect();
            let changes = collect_changes(&paths, &handler_root);
            if !changes.is_empty() {
                let _ = app.emit(CHANGE_EVENT, changes);
            }
        },
    )
    .map_err(|err| AppError::io(err.to_string()))?;

    debouncer
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| AppError::io(err.to_string()))?;

    // Dropping any previous debouncer here stops its thread.
    *lock_watcher(&watcher)? = Some(debouncer);
    drop(graph_guard);
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
    fn tracks_only_markdown_under_note_dirs() {
        let root = Path::new("/g");
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/a.md"), root).as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/daily/2026-06-09.md"), root).as_deref(),
            Some("daily/2026-06-09.md")
        );
        // Not tracked: the index, assets, non-markdown, dotfiles, outside root.
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/index.sqlite"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/g/assets/x.png"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/notes/x.txt"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/README.md"), root), None);
        assert_eq!(tracked_relpath(Path::new("/other/notes/a.md"), root), None);
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
                kind: "remove".to_string()
            }]
        );
    }
}
