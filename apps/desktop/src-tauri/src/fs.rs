//! Graph file-IO primitives (Plan 02).
//!
//! Markdown files are the durable source of truth; this module moves bytes and
//! paths, not meaning. All paths are **graph-relative** — the graph root lives
//! in Rust state and the frontend can never address files outside it
//! (path-traversal guard). Writes are atomic (temp file + rename) and deletes go
//! to the OS trash. Parsing/indexing live in later plans.

use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};

const REFLECT_DIR: &str = ".reflect";
const META_SCHEMA_VERSION: u32 = 1;
const TOP_LEVEL_DIRS: [&str; 4] = ["daily", "notes", "assets", REFLECT_DIR];
/// Directories scanned by `list_files` for markdown notes.
const NOTE_DIRS: [&str; 2] = ["daily", "notes"];

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

// ---- internal helpers (unit-tested directly) -------------------------------

/// Reject a relative path that is absolute, contains `..`/root components, or is
/// empty/dot-only (which would target the graph root itself). Requires at least
/// one real path segment. The primary, lexical path-traversal guard.
fn ensure_relative(rel: &str) -> AppResult<PathBuf> {
    let path = Path::new(rel);
    let mut has_segment = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_segment = true,
            Component::CurDir => {}
            _ => {
                return Err(AppError::traversal(format!(
                    "path escapes the graph root: {rel}"
                )))
            }
        }
    }
    if !has_segment {
        return Err(AppError::traversal(format!(
            "path must point to a file inside the graph, got: {rel:?}"
        )));
    }
    Ok(path.to_path_buf())
}

/// The deepest existing ancestor of `path` (the path itself if it exists).
fn existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path;
    loop {
        if current.exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => current = parent,
            _ => return path.to_path_buf(),
        }
    }
}

/// Resolve a graph-relative path to an absolute path **inside** `root`. Beyond
/// the lexical guard, this canonicalizes the deepest existing ancestor and
/// verifies it stays under the canonicalized root, so a symlink inside the graph
/// can't redirect reads/writes outside it.
fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel = ensure_relative(rel)?;
    let joined = root.join(&rel);
    let canonical_root = root.canonicalize()?;
    let anchor = existing_ancestor(&joined).canonicalize()?;
    if !anchor.starts_with(&canonical_root) {
        return Err(AppError::traversal(format!(
            "path resolves outside the graph: {rel:?}"
        )));
    }
    Ok(joined)
}

/// Create the standard graph layout + ignore/meta files (idempotent).
fn bootstrap(root: &Path) -> AppResult<()> {
    for dir in TOP_LEVEL_DIRS {
        fs::create_dir_all(root.join(dir))?;
    }
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        fs::write(
            &gitignore,
            "# Reflect local index + caches (rebuildable; never committed)\n/.reflect/\n",
        )?;
    }
    let meta = root.join(REFLECT_DIR).join("meta.json");
    if !meta.exists() {
        fs::write(
            &meta,
            format!("{{\n  \"schemaVersion\": {META_SCHEMA_VERSION}\n}}\n"),
        )?;
    }
    Ok(())
}

/// Atomically write `contents` to `target` (temp file in the same dir + rename).
fn atomic_write(target: &Path, contents: &str) -> AppResult<()> {
    atomic_write_bytes(target, contents.as_bytes())
}

/// Byte-level atomic write — shared by notes (text) and assets (binary).
fn atomic_write_bytes(target: &Path, contents: &[u8]) -> AppResult<()> {
    let dir = target
        .parent()
        .ok_or_else(|| AppError::io(format!("no parent directory for {}", target.display())))?;
    fs::create_dir_all(dir)?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir)?;
    tmp.write_all(contents)?;
    tmp.as_file().sync_all()?;
    tmp.persist(target)
        .map_err(|err| AppError::io(err.to_string()))?;
    Ok(())
}

fn modified_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

/// Collect markdown files under `root/dir` into `out` (recursive).
fn collect_markdown(root: &Path, dir: &str, out: &mut Vec<FileMeta>) -> AppResult<()> {
    let base = root.join(dir);
    if !base.is_dir() {
        return Ok(());
    }
    let mut stack = vec![base];
    while let Some(current) = stack.pop() {
        for entry in fs::read_dir(&current)? {
            let entry = entry?;
            // Don't follow symlinks — they can point outside the graph.
            let file_type = entry.file_type()?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if file_type.is_file() && path.extension().and_then(|ext| ext.to_str()) == Some("md") {
                // Skip anything that isn't actually under the root rather than
                // leaking an absolute path.
                let Ok(rel) = path.strip_prefix(root) else {
                    continue;
                };
                let meta = entry.metadata()?;
                out.push(FileMeta {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    size: meta.len(),
                    modified_ms: modified_ms(&meta),
                });
            }
        }
    }
    Ok(())
}

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
        eprintln!("reflect: failed to record recent graph: {err:?}");
    }
    Ok(info)
}

fn lock_graph<'a>(
    state: &'a State<GraphState>,
) -> AppResult<std::sync::MutexGuard<'a, GraphInner>> {
    state
        .0
        .lock()
        .map_err(|_| AppError::io("graph state lock poisoned"))
}

fn current_root(state: &State<GraphState>) -> AppResult<PathBuf> {
    lock_graph(state)?
        .root
        .clone()
        .ok_or_else(AppError::no_graph)
}

/// The current root, verified against the generation a mutating command was
/// issued for. A stale generation means the graph was switched after the
/// command was enqueued — the mutation must be rejected (loudly), or it would
/// land in the *new* graph's same-named file.
fn root_for_generation(state: &State<GraphState>, generation: u64) -> AppResult<PathBuf> {
    let inner = lock_graph(state)?;
    if inner.generation != generation {
        return Err(AppError::io(
            "the graph changed since this write was issued; dropping it",
        ));
    }
    inner.root.clone().ok_or_else(AppError::no_graph)
}

// ---- commands --------------------------------------------------------------

/// Let the asset protocol serve files from the graph (image rendering, Plan 05).
/// Best-effort: a failure means images don't render, never that the open fails.
fn allow_asset_scope(app: &tauri::AppHandle, root: &Path) {
    use tauri::Manager;
    if let Err(err) = app.asset_protocol_scope().allow_directory(root, true) {
        eprintln!("reflect: failed to extend the asset scope: {err}");
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

/// Read a note's markdown by graph-relative path.
#[tauri::command]
pub fn note_read(path: String, state: State<GraphState>) -> AppResult<String> {
    let root = current_root(&state)?;
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

/// Move/rename a note within the graph (pinned to `generation`).
#[tauri::command]
pub fn note_move(
    from: String,
    to: String,
    generation: u64,
    state: State<GraphState>,
) -> AppResult<()> {
    let root = root_for_generation(&state, generation)?;
    let to_abs = resolve(&root, &to)?;
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(resolve(&root, &from)?, to_abs)?;
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

/// List markdown notes under `daily/` and `notes/`.
#[tauri::command]
pub fn list_files(state: State<GraphState>) -> AppResult<Vec<FileMeta>> {
    let root = current_root(&state)?;
    let mut out = Vec::new();
    for dir in NOTE_DIRS {
        collect_markdown(&root, dir, &mut out)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn rejects_path_traversal() {
        assert!(ensure_relative("../secret").is_err());
        assert!(ensure_relative("/etc/passwd").is_err());
        assert!(ensure_relative("notes/../../escape.md").is_err());
        assert!(ensure_relative("notes/ok.md").is_ok());
        assert!(ensure_relative("./daily/2026-06-09.md").is_ok());
    }

    #[test]
    fn rejects_empty_and_dot_only_paths() {
        // These would otherwise resolve to the graph root itself.
        assert!(ensure_relative("").is_err());
        assert!(ensure_relative(".").is_err());
        assert!(ensure_relative("./.").is_err());
    }

    #[test]
    fn resolve_accepts_in_graph_path() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        assert!(resolve(dir.path(), "notes/ok.md").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let outside = tempdir().unwrap();
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        // A symlink inside the graph pointing out of it.
        symlink(outside.path(), graph.path().join("notes/escape")).unwrap();
        assert!(resolve(graph.path(), "notes/escape/evil.md").is_err());
    }

    #[test]
    fn bootstrap_creates_layout() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        for sub in TOP_LEVEL_DIRS {
            assert!(dir.path().join(sub).is_dir(), "missing dir {sub}");
        }
        assert!(dir.path().join(".gitignore").exists());
        assert!(dir.path().join(".reflect/meta.json").exists());
    }

    #[test]
    fn atomic_write_round_trips() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let target = dir.path().join("notes/hello.md");
        atomic_write(&target, "# Hello\n\nworld\n").unwrap();
        assert_eq!(fs::read_to_string(&target).unwrap(), "# Hello\n\nworld\n");
    }

    #[test]
    fn list_finds_only_markdown_under_note_dirs() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        atomic_write(&dir.path().join("notes/a.md"), "a").unwrap();
        atomic_write(&dir.path().join("daily/2026-06-09.md"), "b").unwrap();
        atomic_write(&dir.path().join("notes/skip.txt"), "c").unwrap();

        let mut out = Vec::new();
        for d in NOTE_DIRS {
            collect_markdown(dir.path(), d, &mut out).unwrap();
        }
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"daily/2026-06-09.md"));
        assert!(!paths.iter().any(|p| p.ends_with(".txt")));
    }
}
