//! Filesystem watcher for the open graph (Plan 04b).
//!
//! A debounced `notify` watcher over the graph root. It's the **sole** trigger
//! for incremental re-indexing: an edit (ours or external) writes the markdown
//! file, the watcher fires, and the frontend re-indexes that file. The index
//! lives under `.reflect/`, which is filtered out here, so index writes can't
//! loop back. The watcher reports `.md` under `daily/` and `notes/`, plus
//! anything under `audio-memos/` (recordings feed the sync debounce and the
//! transcription reconciler, not the index) and eligible image/PDF files under
//! `assets/` (which feed the asset-description controller — Plan 20 — not the
//! index; the `.reflect.md` description files are excluded so a write can't loop
//! back). Non-note consumers filter by path. The frontend resolves
//! create-vs-delete and re-indexes (content-hash gated).

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
    /// Last-modified time in epoch milliseconds, set for upserts. The frontend
    /// stamps `notes.mtime` from this — without it, watcher-indexed rows would
    /// carry no real timestamp (and reconcile would never repair them, since it
    /// is content-hash gated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

/// Image and PDF extensions that earn an AI description file (Plan 20). Must
/// stay in sync with `assetTypeFor` in `@reflect/core` (`actions/asset-description`).
const ELIGIBLE_ASSET_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "gif", "webp", "svg", "pdf"];

/// Whether a graph-relative path is an asset the description controller handles:
/// an eligible image/PDF under `assets/`, never a `.reflect.md` description file
/// (which also lives there — tracking it would loop a write back into work).
fn is_eligible_asset(rel_str: &str) -> bool {
    if !rel_str.starts_with("assets/") || rel_str.ends_with(".reflect.md") {
        return false;
    }
    rel_str
        .rsplit('.')
        .next()
        .is_some_and(|ext| ELIGIBLE_ASSET_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
}

/// Graph-relative path if `path` is tracked: a markdown note (`.md` under
/// `daily/`, `notes/`, or `templates/`), an audio-memo recording (anything under
/// `audio-memos/`), a spooled capture envelope (`.json` under `.reflect/inbox/`
/// — the one carve-out from the `.reflect/` blackout; the envelope is the
/// spool's commit point and triggers the capture drain), or an eligible asset
/// under `assets/` ({@link is_eligible_asset} — feeds the description controller),
/// else `None`. Pure — the filtering rule, unit-tested.
fn tracked_relpath(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    // An iCloud eviction placeholder tracks as the file it stands in for —
    // eviction/re-download events must never read as a stub appearing or the
    // note being deleted (Plan 21).
    let rel_str = evicted_logical_relpath(&rel_str).unwrap_or(rel_str);
    let note = (rel_str.starts_with("daily/")
        || rel_str.starts_with("notes/")
        || rel_str.starts_with("templates/"))
        && rel_str.ends_with(".md");
    let recording = rel_str.starts_with("audio-memos/");
    let capture = rel_str.starts_with(".reflect/inbox/") && rel_str.ends_with(".json");
    let asset = is_eligible_asset(&rel_str);
    (note || recording || capture || asset).then_some(rel_str)
}

/// `notes/.a.md.icloud` → `Some("notes/a.md")`: the graph-relative path of the
/// file an iCloud eviction placeholder stands in for, `None` for anything
/// that isn't a placeholder name.
fn evicted_logical_relpath(rel_str: &str) -> Option<String> {
    let (dir, name) = match rel_str.rsplit_once('/') {
        Some((dir, name)) => (Some(dir), name),
        None => (None, rel_str),
    };
    let logical = crate::fs::icloud_placeholder_target(name)?;
    Some(match dir {
        Some(dir) => format!("{dir}/{logical}"),
        None => logical.to_string(),
    })
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
            let change = match std::fs::metadata(&logical) {
                // A dataless file (modern macOS eviction) stats fine but its
                // bytes are remote: emitting an upsert would send the live
                // pass into a blocking on-demand download. Same rule as the
                // stub form below — evicted, not deleted, no event; the
                // re-download (or a targeted request) emits the real upsert.
                Ok(meta) if crate::fs::is_dataless(&meta) => continue,
                Ok(meta) => FileChange {
                    path: rel.clone(),
                    kind: "upsert".to_string(),
                    modified_ms: crate::fs::modified_ms(&meta),
                },
                Err(_) => {
                    if crate::fs::eviction_placeholder(&logical).is_some_and(|stub| stub.exists()) {
                        continue; // evicted, not deleted
                    }
                    FileChange {
                        path: rel.clone(),
                        kind: "remove".to_string(),
                        modified_ms: None,
                    }
                }
            };
            seen.insert(rel, change);
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
    fn tracks_markdown_under_note_dirs_and_audio_memo_recordings() {
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
        assert_eq!(tracked_relpath(Path::new("/g/README.md"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/audio-memos"), root), None);
        assert_eq!(tracked_relpath(Path::new("/other/notes/a.md"), root), None);
    }

    #[test]
    fn tracks_eligible_assets_but_not_description_files_or_other_files() {
        let root = Path::new("/g");
        for ext in ELIGIBLE_ASSET_EXTS {
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
    fn placeholder_events_track_as_their_logical_note() {
        let root = Path::new("/g");
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/.a.md.icloud"), root).as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/audio-memos/.memo.m4a.icloud"), root).as_deref(),
            Some("audio-memos/memo.m4a")
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
