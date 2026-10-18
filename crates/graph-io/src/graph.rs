//! The open graph session (Plan 02): the root plus its generation, the
//! catalog cache, and the note operations that run under the graph lock.
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative**, and the root lives in
//! [`GraphState`], so a caller can never address files outside it
//! (path-traversal guard, [`resolve`]). Writes are atomic (temp file + rename,
//! [`io`]). What a delete does with the file (OS trash, graph-local trash) is
//! the caller's choice, passed into [`delete_note_locked`].

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;

use reflect_graph_paths::eviction_placeholder;
use reflect_types::{AppError, AppResult, FileMeta};

use crate::graph_lock::with_graph_lock;
use crate::io::{self, atomic_write, modified_ms};
use crate::own_writes;
use crate::resolve::resolve;

/// The open graph root plus a monotonic generation, kept **under one lock** so
/// they swap atomically (the same pattern as the index's `IndexState`, Plan 04b).
/// Mutating commands carry the generation they were issued for and are rejected
/// when it's stale — so a write enqueued for one graph can never land in another
/// graph's same-named file after a switch swaps the root.
#[derive(Default)]
pub struct GraphInner {
    pub generation: u64,
    pub root: Option<PathBuf>,
    /// Cached vault catalog for the current root, dropped on every write path
    /// and watcher/iCloud change so listings never pin deleted files.
    catalog: Option<io::FileCatalog>,
    /// Monotonic invalidation epoch. A scan runs without the graph lock; it
    /// may publish into the cache only if no invalidation happened since it
    /// began — otherwise its result is returned to its caller but not pinned.
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

// ---- state accessors --------------------------------------------------------

pub fn graph_info(root: &Path, generation: u64) -> GraphInfo {
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

/// Set the active root (bumping the generation atomically) and return its
/// info. Recording it in recents is the caller's job.
pub fn activate(state: &GraphState, root: &Path) -> AppResult<GraphInfo> {
    let generation = {
        let mut inner = lock_graph(state)?;
        inner.generation += 1;
        inner.root = Some(root.to_path_buf());
        inner.catalog = None;
        inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
        inner.generation
    };
    Ok(graph_info(root, generation))
}

pub fn lock_graph(state: &GraphState) -> AppResult<std::sync::MutexGuard<'_, GraphInner>> {
    state.0.lock().map_err(|err| {
        // A poisoned lock means a command panicked while holding it — the panic
        // itself is the bug; this context points at the blast radius.
        tracing::error!(?err, "graph state lock poisoned by an earlier panic");
        AppError::io("graph state lock poisoned")
    })
}

pub fn current_root(state: &GraphState) -> AppResult<PathBuf> {
    lock_graph(state)?
        .root
        .clone()
        .ok_or_else(AppError::no_graph)
}

/// The open graph's identity as a pure read — the note-window bootstrap
/// (`windows::window_bootstrap`) must *adopt* the session, never re-open it:
/// a generation bump here would strand every command the main window has
/// pinned to the current one.
pub fn current_graph_info(state: &GraphState) -> AppResult<GraphInfo> {
    let inner = lock_graph(state)?;
    let root = inner.root.clone().ok_or_else(AppError::no_graph)?;
    Ok(graph_info(&root, inner.generation))
}

/// The current root, verified against the generation a mutating command was
/// issued for. A stale generation means the graph was switched after the
/// command was enqueued — the mutation must be rejected (loudly), or it would
/// land in the *new* graph's same-named file.
pub fn root_for_generation(state: &GraphState, generation: u64) -> AppResult<PathBuf> {
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
pub fn root_for(state: &GraphState, generation: Option<u64>) -> AppResult<PathBuf> {
    match generation {
        Some(generation) => root_for_generation(state, generation),
        None => current_root(state),
    }
}

/// Reads and OS opens accept any supported attachment anywhere in the vault:
/// an adopted vault keeps its images beside its notes. Classification is the
/// shared `graph-paths` policy, so neither surface can serve a note, a hidden
/// file, or a traversal path. Writes are deliberately untouched — Reflect
/// only ever creates files under `assets/` and `audio-memos/`, and widening
/// reads must not widen what Reflect will write.
pub fn ensure_readable_attachment_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_attachment(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a supported attachment path: {path}"
    )))
}

/// How a local note read (the desktop `note_read_local` command) found the
/// note on disk.
#[derive(Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum LocalNoteRead {
    /// The bytes are local; here they are.
    Content { content: String },
    /// The note is iCloud-evicted (a dataless file, or an `.icloud` stub in
    /// the logical path's place). Reading it would block on an on-demand
    /// download — this command refuses instead.
    Evicted,
}

/// What a note write left on disk.
#[derive(Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteWriteOutcome {
    /// The note's on-disk mtime (epoch ms) after the call.
    pub modified_ms: Option<u64>,
    /// The full note text now on disk, when the note had moved past the
    /// expected revision and the file holds something other than `contents`.
    pub merged: Option<String>,
}

/// A checked write whose file moved past `expected` merges through the
/// conflict ladder. `still_current` runs under the graph lock before any write.
pub fn write_note_revision(
    root: &Path,
    path: &str,
    contents: &str,
    checked: bool,
    expected: Option<&str>,
    still_current: impl FnOnce() -> AppResult<()>,
) -> AppResult<NoteWriteOutcome> {
    with_graph_lock(root, || {
        still_current()?;
        let target = resolve(root, path)?;
        if checked {
            let current = match io::read_note_no_follow(root, &target) {
                Ok(value) => Some(value),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(error.into()),
            };
            match (expected, current) {
                (None, None) => {}
                (Some(base), Some(current)) if current != base => {
                    return merge_into_moved_note(root, path, &target, contents, base, current);
                }
                (Some(_), Some(_)) => {}
                _ => return Err(AppError::io("Note changed on disk; reload before retrying")),
            }
        }
        write_own(root, path, &target, contents)
    })
}

/// Write a note without a revision check, for tests that stage a file. The
/// caller holds the graph lock.
#[cfg(any(test, feature = "test-support"))]
pub fn write_unchecked(root: &Path, rel: &str, contents: &str) -> AppResult<NoteWriteOutcome> {
    write_own(root, rel, &resolve(root, rel)?, contents)
}

fn write_own(root: &Path, rel: &str, target: &Path, contents: &str) -> AppResult<NoteWriteOutcome> {
    let modified_ms = atomic_write(root, target, contents)?;
    own_writes::record(root, rel, contents.as_bytes());
    Ok(NoteWriteOutcome {
        modified_ms,
        merged: None,
    })
}

fn merge_into_moved_note(
    root: &Path,
    rel: &str,
    target: &Path,
    contents: &str,
    base: &str,
    current: String,
) -> AppResult<NoteWriteOutcome> {
    use crate::conflict::ladder::{self, ConflictInput};
    use crate::conflict::{ConflictSide, Resolution};

    let disk_ms = fs::metadata(target).ok().as_ref().and_then(modified_ms);
    let unchanged = |merged: Option<String>| NoteWriteOutcome {
        modified_ms: disk_ms,
        merged,
    };
    if current == contents {
        return Ok(unchanged(None));
    }
    let disk_ms_value = disk_ms.unwrap_or(0);
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
        .max(disk_ms_value + 1);
    let resolution = ladder::resolve(ConflictInput {
        base: Some(base),
        sides: (
            ConflictSide {
                content: contents.to_string(),
                modified_ms: now_ms,
            },
            ConflictSide {
                content: current.clone(),
                modified_ms: disk_ms_value,
            },
        ),
        merge_loop_detected: false,
    })?;
    let content = match resolution {
        Resolution::AlreadyResolved => return Ok(unchanged(None)),
        Resolution::Merged { content } | Resolution::Reconciled { content } => content,
    };
    if content == current {
        return Ok(unchanged(Some(content)));
    }
    let modified_ms = write_own(root, rel, target, &content)?.modified_ms;
    Ok(NoteWriteOutcome {
        modified_ms,
        merged: Some(content),
    })
}

/// The per-segment transcript cache lives under `.reflect/transcripts/`:
/// derived, rebuildable data (deleting it re-bills a transcription, never
/// loses content), invisible to the watcher, indexer, and sync like the rest
/// of `.reflect/`. It gets its own narrow commands because the attachment
/// IPC is deliberately fenced to `assets/` and `audio-memos/`.
pub fn transcript_cache_file(root: &Path, name: &str) -> AppResult<std::path::PathBuf> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains('\0')
        || name == "."
        || name == ".."
    {
        return Err(AppError::traversal(format!(
            "transcript cache name must be a plain filename: {name:?}"
        )));
    }
    // Through the shared guard: a cache directory (or entry) symlinked
    // outside the graph must not redirect IO past the generation-pinned
    // root. The plain-filename check above stays — `resolve` would accept a
    // nested relative path, and a cache name must be a single segment.
    let path = resolve(root, &format!(".reflect/transcripts/{name}"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(path)
}

pub fn ensure_revealable_path(path: &str) -> AppResult<()> {
    if reflect_graph_paths::is_safe_visible(path) {
        return Ok(());
    }
    Err(AppError::traversal(format!(
        "not a revealable path: {path}"
    )))
}

/// Rename `from` → `to` on disk (both graph-relative, traversal-guarded).
///
/// An occupied destination refuses (loudly), matching the projection half
/// (`db::write::move_note`): the collision probe raced something — nothing is
/// deleted or overwritten, the caller compensates, and the rename simply
/// reports failed. One rule, no adoption heuristics; the filename drifts
/// until the next settled rename retries.
pub fn move_note_file(root: &Path, from: &str, to: &str) -> AppResult<()> {
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

pub fn delete_note_locked(
    root: &Path,
    path: &str,
    trash: impl FnOnce(&Path) -> AppResult<()>,
) -> AppResult<()> {
    let abs = resolve(root, path)?;
    // An iCloud-evicted note exists only as its `.name.md.icloud` stub —
    // trashing the logical path would fail and the note would be
    // undeletable. Removing the stub deletes the iCloud item (Plan 21).
    let target = if abs.exists() {
        abs
    } else {
        eviction_placeholder(&abs)
            .filter(|stub| stub.exists())
            .unwrap_or(abs)
    };
    trash(&target)?;
    // A deleted note's sync ancestor is meaningless — drop it (Plan 21).
    crate::conflict::shadow::ShadowStore::new(root).forget(path);
    Ok(())
}

/// Move a deleted file under `<graph>/.reflect/trash/`, stamping the name
/// with epoch millis — and a counter beyond that — until the name is free
/// (repeat deletes of `a.md`, even within one millisecond).
pub fn move_to_graph_trash(root: &Path, abs: &Path) -> AppResult<()> {
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

/// Counts from the vault catalog. `skipped` is what the walk refused or
/// failed to list (unreadable directories, symlinks, default-pruned trees) —
/// the number that keeps "why isn't my file showing up" diagnosable.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultScanStats {
    pub notes: u32,
    pub attachments: u32,
    pub skipped: u32,
}

/// The same note listing as the desktop `list_files` command, callable with a plain root — the
/// iCloud conflict sweep and the index reconcile walk the disk fresh, outside
/// the cache: reconcile's whole job is to re-verify what is actually there.
pub fn note_files(root: &Path) -> Vec<FileMeta> {
    io::collect_note_files(root)
}

/// Notes and supported attachments from one fresh walk of the disk.
pub fn note_and_attachment_files(root: &Path) -> (Vec<FileMeta>, Vec<FileMeta>) {
    let catalog = io::collect_file_catalog(root);
    (catalog.notes, catalog.attachments)
}

/// Cached catalog for the current graph. The scan runs without the graph
/// lock; the result is always returned to the caller (fresh as of its own
/// start), and is published into the cache only when generation, root, and
/// invalidation epoch are unchanged — a snapshot that predates a concurrent
/// write may serve its own caller but must never be pinned. No retry loop:
/// under sustained writes every caller simply keeps paying for its own scan.
pub fn file_catalog(state: &GraphState, generation: Option<u64>) -> AppResult<io::FileCatalog> {
    file_catalog_with(state, generation, io::collect_file_catalog)
}

fn file_catalog_with<F>(
    state: &GraphState,
    generation: Option<u64>,
    scan: F,
) -> AppResult<io::FileCatalog>
where
    F: FnOnce(&Path) -> io::FileCatalog,
{
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

    let catalog = scan(&root);
    let mut inner = lock_graph(state)?;
    if inner.generation == expected_generation
        && inner.root.as_deref() == Some(root.as_path())
        && inner.catalog.is_none()
        && inner.catalog_revision == expected_revision
    {
        inner.catalog = Some(catalog.clone());
    }
    Ok(catalog)
}

/// Invalidate the session for a graph delete: under one lock hold, check the
/// generation, clear the root and bump the generation, so a pinned write that
/// waited on the graph lock fails its re-check afterwards instead of
/// recreating directories under the trashed path.
pub fn invalidate_for_delete(state: &GraphState, generation: u64) -> AppResult<()> {
    let mut inner = lock_graph(state)?;
    if inner.generation != generation {
        return Err(AppError::io(
            "the graph changed since this command was issued; dropping it",
        ));
    }
    inner.root.take().ok_or_else(AppError::no_graph)?;
    inner.generation += 1;
    inner.catalog = None;
    inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
    Ok(())
}

/// Invalidate the catalog only if `root` is still the active generation's
/// root. A late watcher/iCloud callback for a previous graph is harmless.
pub fn invalidate_file_catalog(state: &GraphState, root: &Path) {
    match state.0.lock() {
        Ok(mut inner) if inner.root.as_deref() == Some(root) => {
            inner.catalog = None;
            inner.catalog_revision = inner.catalog_revision.wrapping_add(1);
        }
        Ok(_) => {}
        Err(error) => tracing::error!(
            ?error,
            "graph state lock poisoned while invalidating catalog"
        ),
    }
}

#[cfg(test)]
mod transcript_cache_tests {
    use super::transcript_cache_file;

    #[test]
    fn accepts_a_plain_name_and_creates_the_cache_dir() {
        let graph = tempfile::tempdir().expect("graph");
        let path = transcript_cache_file(graph.path(), "memo.part-001.m4a.json").expect("path");
        assert!(path.ends_with(".reflect/transcripts/memo.part-001.m4a.json"));
        assert!(graph.path().join(".reflect/transcripts").is_dir());
    }

    #[test]
    fn rejects_path_shaped_names() {
        let graph = tempfile::tempdir().expect("graph");
        assert!(transcript_cache_file(graph.path(), "../escape.json").is_err());
        assert!(transcript_cache_file(graph.path(), "a/b.json").is_err());
        assert!(transcript_cache_file(graph.path(), "").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_cache_dir_symlinked_outside_the_graph() {
        let graph = tempfile::tempdir().expect("graph");
        let outside = tempfile::tempdir().expect("outside");
        std::fs::create_dir_all(graph.path().join(".reflect")).expect("reflect dir");
        std::os::unix::fs::symlink(outside.path(), graph.path().join(".reflect/transcripts"))
            .expect("symlink");
        assert!(transcript_cache_file(graph.path(), "memo.json").is_err());
    }
}

#[cfg(test)]
mod file_catalog_tests {
    use super::{file_catalog, file_catalog_with, invalidate_file_catalog, GraphInner, GraphState};
    use std::fs;
    use std::sync::Mutex;

    fn graph_at(root: &std::path::Path, generation: u64) -> GraphState {
        GraphState(Mutex::new(GraphInner {
            generation,
            root: Some(root.to_path_buf()),
            catalog: None,
            catalog_revision: 0,
        }))
    }

    #[test]
    fn catalog_is_cached_until_invalidated_and_pinned_to_the_generation() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        fs::create_dir_all(vault.path().join("Media")).expect("create media");
        fs::write(vault.path().join("Media/diagram.png"), b"png").expect("write attachment");
        let graph = graph_at(vault.path(), 7);

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
    fn invalidation_from_an_old_root_cannot_clear_the_active_catalog() {
        let vault = tempfile::tempdir().expect("vault");
        let old_vault = tempfile::tempdir().expect("old vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        let graph = graph_at(vault.path(), 3);
        file_catalog(&graph, Some(3)).expect("catalog");

        invalidate_file_catalog(&graph, old_vault.path());

        assert!(graph.0.lock().expect("graph lock").catalog.is_some());
    }

    #[test]
    fn a_scan_racing_an_invalidation_serves_its_caller_but_is_never_pinned() {
        let vault = tempfile::tempdir().expect("vault");
        fs::write(vault.path().join("README.md"), "# Root\n").expect("write root note");
        let graph = graph_at(vault.path(), 5);

        let stale = file_catalog_with(&graph, Some(5), |root| {
            let scanned = super::io::collect_file_catalog(root);
            // A write lands while the scan is in flight: the scan's snapshot
            // may serve its own caller, but must not become the cache.
            fs::write(root.join("arrived.md"), "# Arrived\n").expect("write racing note");
            invalidate_file_catalog(&graph, root);
            scanned
        })
        .expect("racing catalog");
        assert_eq!(stale.notes.len(), 1);
        assert!(graph.0.lock().expect("graph lock").catalog.is_none());

        let fresh = file_catalog(&graph, Some(5)).expect("fresh catalog");
        assert_eq!(
            fresh
                .notes
                .iter()
                .map(|file| file.path.as_str())
                .collect::<Vec<_>>(),
            vec!["README.md", "arrived.md"]
        );
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
mod move_tests {
    use super::{ensure_readable_attachment_path, ensure_revealable_path, move_note_file};
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
    fn asset_open_accepts_supported_attachments_anywhere_and_nothing_else() {
        assert!(ensure_readable_attachment_path("assets/cat.png").is_ok());
        assert!(ensure_readable_attachment_path("assets/report.docx").is_ok());
        assert!(ensure_readable_attachment_path("assets/archive.zip").is_ok());
        assert!(ensure_readable_attachment_path("Projects/Media/cat.png").is_ok());
        assert!(ensure_readable_attachment_path("audio-memos/memo.m4a").is_ok());
        // Notes, hidden components, traversal, extensionless paths, and
        // executable formats refuse.
        assert!(ensure_readable_attachment_path("notes/secret.md").is_err());
        assert!(ensure_readable_attachment_path("tools/script.sh").is_err());
        assert!(ensure_readable_attachment_path(".obsidian/cat.png").is_err());
        assert!(ensure_readable_attachment_path("../cat.png").is_err());
        assert!(ensure_readable_attachment_path("assets/").is_err());
        assert!(ensure_readable_attachment_path("assets").is_err());
    }

    #[test]
    fn asset_reveal_accepts_any_safe_visible_path_and_nothing_else() {
        // The reveal fallback must cover exactly the files the open guard
        // refuses by extension, so it checks lexical safety only.
        assert!(ensure_revealable_path("assets/tool.xyz").is_ok());
        assert!(ensure_revealable_path("assets/report.docx").is_ok());
        assert!(ensure_revealable_path("Projects/Media/cat.png").is_ok());
        assert!(ensure_revealable_path(".reflect/index.sqlite").is_err());
        assert!(ensure_revealable_path("../outside.png").is_err());
        assert!(ensure_revealable_path("/absolute.png").is_err());
    }
}

#[cfg(test)]
mod note_revision_tests {
    use super::*;

    #[test]
    fn poisoned_ordering_lock_does_not_disable_note_writes() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().to_path_buf();
        let _ = std::panic::catch_unwind(|| {
            let _: AppResult<()> = with_graph_lock(&root, || panic!("simulated writer panic"));
        });
        let target = directory.path().join("note.md");
        write_note_revision(directory.path(), "note.md", "saved", true, None, || Ok(())).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "saved");
    }

    #[test]
    fn expected_revision_is_compared_with_lf_line_endings() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, "a\r\nb\r\n").unwrap();
        let outcome = write_note_revision(
            directory.path(),
            "note.md",
            "a\nb!\n",
            true,
            Some("a\nb\n"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(outcome.merged, None);
        assert_eq!(fs::read_to_string(target).unwrap(), "a\nb!\n");
    }

    #[test]
    fn stale_revision_does_not_replace_newer_text() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        fs::write(&target, "user edited this").unwrap();
        let outcome = write_note_revision(
            directory.path(),
            "daily.md",
            "bookmark",
            true,
            Some("old text"),
            || Ok(()),
        )
        .unwrap();
        let on_disk = fs::read_to_string(&target).unwrap();
        for word in ["user", "edited", "this", "bookmark"] {
            assert!(on_disk.contains(word), "{word} missing from {on_disk:?}");
        }
        assert_eq!(outcome.merged, Some(on_disk));
        write_note_revision(
            directory.path(),
            "daily.md",
            "user edited this\nbookmark",
            true,
            Some(&fs::read_to_string(&target).unwrap()),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(&target).unwrap(),
            "user edited this\nbookmark"
        );
    }

    #[test]
    fn a_checked_write_against_a_moved_file_merges_under_the_lock() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, "a\nb\nc\nd\n").unwrap();
        let outcome = write_note_revision(
            directory.path(),
            "note.md",
            "A\nb\nc\n",
            true,
            Some("a\nb\nc\n"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(outcome.merged, Some("A\nb\nc\nd\n".to_string()));
        assert_eq!(fs::read_to_string(&target).unwrap(), "A\nb\nc\nd\n");
        assert_eq!(
            outcome.modified_ms,
            fs::metadata(&target).ok().as_ref().and_then(modified_ms)
        );
        assert!(own_writes::is_own(
            directory.path(),
            "note.md",
            b"A\nb\nc\nd\n"
        ));
    }

    #[test]
    fn a_disk_file_with_marker_text_merges_as_plain_text() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let target = root.join("note.md");
        let base = "intro\n\nmiddle\n\noutro\n";
        let disk =
            "intro\n\n<<<<<<< mac\nmiddle mac\n=======\nmiddle phone\n>>>>>>> phone\n\noutro\n";
        fs::write(&target, disk).unwrap();
        let mine = "INTRO\n\nmiddle\n\noutro\n";
        let outcome =
            write_note_revision(root, "note.md", mine, true, Some(base), || Ok(())).unwrap();
        let merged = outcome.merged.unwrap();
        assert!(merged.starts_with("INTRO\n"), "{merged}");
        assert!(
            merged.contains("<<<<<<< mac\nmiddle mac\n=======\nmiddle phone\n>>>>>>> phone\n"),
            "{merged}"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), merged);
    }

    #[test]
    fn an_identical_racing_write_is_a_no_op() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("note.md");
        fs::write(&target, "a\nb\n").unwrap();
        let before = fs::metadata(&target).ok().as_ref().and_then(modified_ms);
        let outcome = write_note_revision(
            directory.path(),
            "note.md",
            "a\nb\n",
            true,
            Some("a\n"),
            || Ok(()),
        )
        .unwrap();
        assert_eq!(
            outcome,
            NoteWriteOutcome {
                modified_ms: before,
                merged: None,
            }
        );
        assert!(!directory.path().join(".reflect").exists());
    }

    #[test]
    fn outcome_serializes_for_the_typescript_boundary() {
        assert_eq!(
            serde_json::to_value(NoteWriteOutcome {
                modified_ms: Some(7),
                merged: None,
            })
            .unwrap(),
            serde_json::json!({ "modifiedMs": 7, "merged": null })
        );
    }

    #[test]
    fn missing_revision_never_clobbers_an_existing_daily() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("daily.md");
        write_note_revision(directory.path(), "daily.md", "first", true, None, || Ok(())).unwrap();
        assert!(write_note_revision(
            directory.path(),
            "daily.md",
            "second",
            true,
            None,
            || Ok(())
        )
        .is_err());
        assert_eq!(fs::read_to_string(&target).unwrap(), "first");
    }
}

#[cfg(test)]
mod graph_delete_race_tests {
    use super::{
        invalidate_for_delete, root_for_generation, with_graph_lock, write_note_revision,
        GraphInner, GraphState,
    };
    use crate::graph_lock;
    use std::sync::{mpsc, Mutex};
    use std::time::{Duration, Instant};

    /// A write that waited on the graph lock behind a delete must fail its
    /// generation re-check instead of recreating directories under the
    /// trashed root.
    #[test]
    fn a_write_queued_behind_graph_delete_does_not_recreate_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("graph");
        std::fs::create_dir_all(root.join("notes")).unwrap();
        let graph = GraphState(Mutex::new(GraphInner {
            generation: 1,
            root: Some(root.clone()),
            catalog: None,
            catalog_revision: 0,
        }));

        std::thread::scope(|scope| {
            let (locked_tx, locked_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel::<()>();
            // Stands in for `graph_delete`: invalidate and trash under the lock.
            let root = &root;
            let graph = &graph;
            let deleter = scope.spawn(move || {
                with_graph_lock(root, || {
                    locked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    invalidate_for_delete(graph, 1)?;
                    std::fs::remove_dir_all(root)?;
                    Ok(())
                })
            });
            locked_rx.recv().unwrap();
            let writer = scope.spawn(move || {
                write_note_revision(root, "notes/late.md", "# Late\n", false, None, || {
                    root_for_generation(graph, 1).map(drop)
                })
            });
            let deadline = Instant::now() + Duration::from_secs(10);
            while graph_lock::holders(root) < 2 {
                assert!(Instant::now() < deadline, "the write never queued");
                std::thread::sleep(Duration::from_millis(5));
            }
            release_tx.send(()).unwrap();
            deleter.join().unwrap().unwrap();
            let error = writer.join().unwrap().unwrap_err();
            assert!(error.message().contains("graph changed"), "{error:?}");
        });
        assert!(!root.exists());
    }
}
