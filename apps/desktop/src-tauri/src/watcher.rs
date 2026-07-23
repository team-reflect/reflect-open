//! Filesystem watcher for the open graph (Plan 04b).
//!
//! A debounced `notify` watcher over the graph root. It's the **sole** trigger
//! for incremental re-indexing: an edit (ours or external) writes the markdown
//! file, the watcher fires, and the frontend re-indexes that file. The index
//! lives under `.reflect/`, which is filtered out here, so index writes can't
//! loop back. The watcher reports eligible markdown notes and supported
//! attachments anywhere in the vault (the shared `reflect-graph-paths`
//! policy), plus anything under `audio-memos/` (recordings feed the sync
//! debounce and the transcription reconciler, not the index) and capture
//! envelopes under `.reflect/inbox/`. Non-note consumers filter by path. The
//! frontend resolves create-vs-delete and re-indexes (content-hash gated).
//!
//! Directory-level changes are deliberately **not** diffed here: no platform
//! enumerates the descendants of a renamed or removed folder, so the watcher
//! only reports "something structural changed" (`index:reconcile`) and the
//! frontend answers with its ordinary full reconcile pass — re-list, hash
//! gate, prune. One coarse signal instead of a shadow manifest.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use reflect_graph_paths::{
    classify, evicted_logical_path, eviction_placeholder, has_pruned_component, wire_path,
    GraphPathKind,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

/// The Tauri event name carrying batched {@link FileChange}s to the frontend.
const CHANGE_EVENT: &str = "index:changed";

/// The coarse dirty signal: a visible directory was created, renamed, or
/// removed (or the platform demanded a rescan), and its descendants were
/// never enumerated per file. Carries no payload — the frontend answers with
/// one full reconcile pass.
const RECONCILE_EVENT: &str = "index:reconcile";

/// Holds the active debouncer; dropping it stops the background watch thread.
#[derive(Default)]
pub struct WatcherState(pub Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>);

/// A debounced change to a tracked file, sent to the frontend.
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

/// What one debounced batch amounts to: precise per-file changes, and/or the
/// coarse signal that a full reconcile is needed.
#[derive(Debug, Default, PartialEq)]
struct BatchEffects {
    changes: Vec<FileChange>,
    reconcile: bool,
}

/// Graph-relative wire path if `path` is tracked: an eligible markdown note
/// or supported attachment anywhere visible (the shared classification), an
/// audio-memo recording (anything under `audio-memos/`), or a spooled capture
/// envelope (`.json` under `.reflect/inbox/` — the one carve-out from the
/// `.reflect/` blackout; the envelope is the spool's commit point and
/// triggers the capture drain), else `None`. Pure — the filtering rule,
/// unit-tested.
fn tracked_relpath(path: &Path, root: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let rel_str = rel.to_string_lossy().replace('\\', "/");
    if rel_str.starts_with(".reflect/inbox/") && rel_str.ends_with(".json") {
        return Some(rel_str);
    }
    // An iCloud eviction placeholder tracks as the file it stands in for —
    // eviction/re-download events must never read as a stub appearing or the
    // note being deleted (Plan 21).
    let logical = evicted_logical_path(rel);
    let rel = logical.as_deref().unwrap_or(rel);
    let wire = wire_path(rel)?;
    // The walk's lexical exclusions apply to live events too: a write under
    // `node_modules/` must not reach the index through the watcher when the
    // listing will never contain it.
    if has_pruned_component(&wire) {
        return None;
    }
    let kind = classify(&wire);
    let tracked = kind == Some(GraphPathKind::Note)
        || kind == Some(GraphPathKind::Attachment)
        || wire.starts_with("audio-memos/");
    tracked.then_some(wire)
}

/// Reduce a debounced batch of paths to unique tracked changes (last kind
/// wins) plus the coarse reconcile signal. Create/modify vs delete is decided
/// by whether the file currently stats; the same stat supplies the upsert's
/// `modified_ms`. A file that is gone but has an eviction placeholder in its
/// place was offloaded by iCloud, not deleted: no event — the index keeps its
/// last-known content until re-download.
///
/// An **untracked but visible** path flips `reconcile` when it is (or was) a
/// directory: a folder created, renamed, or removed can hold tracked
/// descendants the platform never enumerates. Hidden paths (`.reflect/`
/// index churn, `.git/`) can never flip it — that is what keeps the
/// reconcile pass's own index writes from looping back in here.
fn collect_changes(paths: &[PathBuf], root: &Path) -> BatchEffects {
    let mut seen: std::collections::BTreeMap<String, FileChange> =
        std::collections::BTreeMap::new();
    let mut reconcile = false;
    for path in paths {
        if let Some(rel) = tracked_relpath(path, root) {
            // Stat the *logical* path — for placeholder events it differs
            // from the event path, and it is what consumers read.
            let logical = root.join(&rel);
            let change = match std::fs::symlink_metadata(&logical) {
                // Discovery never lists symlinks; a tracked name replaced by
                // one must leave the index rather than be read through.
                Ok(meta) if meta.file_type().is_symlink() => FileChange {
                    path: rel.clone(),
                    kind: "remove".to_string(),
                    modified_ms: None,
                },
                // A directory took a tracked file's name: membership changed
                // in a way only a re-listing resolves.
                Ok(meta) if meta.is_dir() => {
                    reconcile = true;
                    continue;
                }
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
                    // `symlink_metadata` on the stub so a symlinked `.icloud`
                    // decoy cannot suppress a real removal.
                    let evicted = eviction_placeholder(&logical).is_some_and(|stub| {
                        std::fs::symlink_metadata(&stub)
                            .is_ok_and(|meta| meta.file_type().is_file())
                    });
                    if evicted {
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
        } else if let Ok(rel) = path.strip_prefix(root) {
            let visible = wire_path(rel).is_some_and(|wire| !has_pruned_component(&wire));
            if !visible {
                continue; // hidden, pruned, or unrepresentable — the blackout
            }
            match std::fs::symlink_metadata(path) {
                Ok(meta) if meta.is_dir() => reconcile = true,
                // Gone, and not a tracked file's removal: this may have been
                // a directory rename-away — only a re-listing can tell.
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => reconcile = true,
                _ => {}
            }
        }
    }
    BatchEffects {
        changes: seen.into_values().collect(),
        reconcile,
    }
}

fn lock_watcher<'a>(
    watcher: &'a State<WatcherState>,
) -> AppResult<std::sync::MutexGuard<'a, Option<Debouncer<RecommendedWatcher, RecommendedCache>>>> {
    watcher.0.lock().map_err(|err| {
        tracing::error!(?err, "watcher state lock poisoned by an earlier panic");
        AppError::io("watcher state lock poisoned")
    })
}

/// Start (or restart) watching the active graph; emits `index:changed`
/// batches and `index:reconcile` signals.
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
            let rescan_demanded = events.iter().any(|event| event.need_rescan());
            let paths: Vec<PathBuf> = events
                .iter()
                .flat_map(|event| event.paths.clone())
                .collect();
            let mut effects = collect_changes(&paths, &handler_root);
            effects.reconcile |= rescan_demanded;
            if effects.reconcile || !effects.changes.is_empty() {
                // Drop the cached catalog before telling the frontend: its
                // follow-up `list_files` must re-walk, not replay the cache.
                crate::fs::invalidate_file_catalog(&app.state::<GraphState>(), &handler_root);
            }
            if !effects.changes.is_empty() {
                let _ = app.emit(CHANGE_EVENT, &effects.changes);
            }
            if effects.reconcile {
                let _ = app.emit(RECONCILE_EVENT, ());
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
    fn tracks_eligible_markdown_anywhere_and_recordings() {
        let root = Path::new("/g");
        assert_eq!(
            tracked_relpath(Path::new("/g/notes/a.md"), root).as_deref(),
            Some("notes/a.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/daily/2026-06-09.md"), root).as_deref(),
            Some("daily/2026-06-09.md")
        );
        // Templates are tracked like notes; only lowercase `.md` files count.
        assert_eq!(
            tracked_relpath(Path::new("/g/templates/journal.md"), root).as_deref(),
            Some("templates/journal.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/templates/journal.txt"), root),
            None
        );
        // Adopted vaults keep markdown anywhere visible: root and nested
        // paths are tracked, hidden trees and uppercase `.MD` are not.
        assert_eq!(
            tracked_relpath(Path::new("/g/README.md"), root).as_deref(),
            Some("README.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/deep/plan.md"), root).as_deref(),
            Some("Projects/deep/plan.md")
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/.obsidian/note.md"), root),
            None
        );
        assert_eq!(
            tracked_relpath(Path::new("/g/Projects/upper.MD"), root),
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
        // audio-memos directory entry itself.
        assert_eq!(
            tracked_relpath(Path::new("/g/.reflect/index.sqlite"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/g/notes/x.txt"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/audio-memos"), root), None);
        assert_eq!(tracked_relpath(Path::new("/other/notes/a.md"), root), None);
    }

    #[test]
    fn tracks_supported_attachments_but_never_description_files() {
        let root = Path::new("/g");
        for rel in ["assets/diagram.png", "Media/PHOTO.JPEG", "Docs/ref.pdf"] {
            let path = format!("/g/{rel}");
            assert_eq!(
                tracked_relpath(Path::new(&path), root).as_deref(),
                Some(rel)
            );
        }
        // The description file lives under assets/ too — tracking it would
        // loop a write back into the controller, so it must never be tracked
        // (`assets/` is a reserved tree: its markdown is metadata, not notes).
        assert_eq!(
            tracked_relpath(Path::new("/g/assets/diagram.png.reflect.md"), root),
            None
        );
        assert_eq!(tracked_relpath(Path::new("/g/assets/data.txt"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/assets/notes.md"), root), None);
        assert_eq!(tracked_relpath(Path::new("/g/assets/noext"), root), None);
    }

    #[test]
    fn collect_changes_dedupes_and_marks_missing_as_remove() {
        let root = Path::new("/g");
        // These paths don't exist on disk → "remove"; deduped by path. A
        // missing *tracked* file is a precise removal, never a reconcile.
        let effects = collect_changes(
            &[
                PathBuf::from("/g/notes/a.md"),
                PathBuf::from("/g/notes/a.md"),
                PathBuf::from("/g/.reflect/index.sqlite"),
            ],
            root,
        );
        assert_eq!(
            effects.changes,
            vec![FileChange {
                path: "notes/a.md".to_string(),
                kind: "remove".to_string(),
                modified_ms: None,
            }]
        );
        assert!(!effects.reconcile);
    }

    #[test]
    fn collect_changes_stamps_upserts_with_the_file_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let note = root.join("notes/a.md");
        std::fs::write(&note, "# a").unwrap();

        let effects = collect_changes(&[note], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].path, "notes/a.md");
        assert_eq!(effects.changes[0].kind, "upsert");
        // A real timestamp, not epoch zero — All Notes sorts and labels by it.
        assert!(effects.changes[0].modified_ms.is_some_and(|ms| ms > 0));
        assert!(!effects.reconcile);
    }

    #[test]
    fn directory_events_demand_a_reconcile_not_a_diff() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("Projects/deep")).unwrap();

        // A visible directory that exists (created or renamed in)…
        let created = collect_changes(&[root.join("Projects")], root);
        assert!(created.reconcile);
        assert!(created.changes.is_empty());

        // …and a visible path that is gone (renamed away or removed): the
        // platform never enumerates the descendants either way.
        let removed = collect_changes(&[root.join("Archive")], root);
        assert!(removed.reconcile);
    }

    #[test]
    fn pruned_dependency_trees_are_invisible_to_live_events() {
        // `npm install` inside an adopted vault: thousands of markdown files
        // land under `node_modules/`, none of which the listing will ever
        // contain. The watcher must neither upsert them nor reconcile for
        // them — the same lexical rule the walk prunes by.
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        std::fs::write(root.join("node_modules/pkg/README.md"), "# dep").unwrap();

        assert_eq!(
            tracked_relpath(&root.join("node_modules/pkg/README.md"), root),
            None
        );
        let effects = collect_changes(
            &[
                root.join("node_modules/pkg/README.md"),
                root.join("node_modules/pkg"),
            ],
            root,
        );
        assert_eq!(effects, BatchEffects::default());
    }

    #[test]
    fn hidden_churn_never_triggers_a_reconcile() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join(".reflect")).unwrap();
        // Index writes and checkpoints under `.reflect/` — exactly what the
        // reconcile pass itself produces. Feeding them back as reconcile
        // demands would loop forever.
        let effects = collect_changes(
            &[
                root.join(".reflect/index.sqlite"),
                root.join(".reflect/index.sqlite-wal"),
                root.join(".git/objects/pack"),
            ],
            root,
        );
        assert_eq!(effects, BatchEffects::default());
    }

    #[cfg(unix)]
    #[test]
    fn a_note_replaced_by_a_symlink_reads_as_removal() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(outside.path().join("secret.md"), "# outside").unwrap();
        symlink(outside.path().join("secret.md"), root.join("notes/a.md")).unwrap();

        let effects = collect_changes(&[root.join("notes/a.md")], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].kind, "remove");
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
        let effects = collect_changes(
            &[root.join("notes/a.md"), root.join("notes/.a.md.icloud")],
            root,
        );
        assert_eq!(effects, BatchEffects::default());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_stub_cannot_suppress_a_removal() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("notes")).unwrap();
        std::fs::write(outside.path().join("decoy"), b"stub").unwrap();
        symlink(
            outside.path().join("decoy"),
            root.join("notes/.a.md.icloud"),
        )
        .unwrap();

        let effects = collect_changes(&[root.join("notes/a.md")], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].kind, "remove");
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

        let effects = collect_changes(&[root.join("notes/.a.md.icloud")], root);
        assert_eq!(effects.changes.len(), 1);
        assert_eq!(effects.changes[0].path, "notes/a.md");
        assert_eq!(effects.changes[0].kind, "upsert");
    }
}
