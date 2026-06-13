//! Disk primitives: graph bootstrap, atomic writes, and markdown listing.
//!
//! Pure IO — no Tauri state, no path policy (that's [`super::resolve`]). Writes
//! are atomic (temp file in the target dir + rename) so a crash mid-write can
//! never truncate a note.

use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{AppError, AppResult};
use crate::graph_gitignore;

use super::FileMeta;

pub(super) const REFLECT_DIR: &str = ".reflect";
const META_SCHEMA_VERSION: u32 = 1;
pub(super) const TOP_LEVEL_DIRS: [&str; 4] = ["daily", "notes", "assets", REFLECT_DIR];
/// Directories scanned by `list_files` for markdown notes.
pub(super) const NOTE_DIRS: [&str; 2] = ["daily", "notes"];

/// Create the standard graph layout + ignore/meta files (idempotent).
pub(super) fn bootstrap(root: &Path) -> AppResult<()> {
    for dir in TOP_LEVEL_DIRS {
        fs::create_dir_all(root.join(dir))?;
    }
    let gitignore = root.join(".gitignore");
    if !gitignore.exists() {
        fs::write(&gitignore, graph_gitignore::default_contents())?;
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
pub(super) fn atomic_write(target: &Path, contents: &str) -> AppResult<()> {
    atomic_write_bytes(target, contents.as_bytes())
}

/// Byte-level atomic write — shared by notes (text) and assets (binary).
pub(super) fn atomic_write_bytes(target: &Path, contents: &[u8]) -> AppResult<()> {
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

/// Last-modified time in epoch milliseconds, or `None` when the platform
/// can't provide one. Shared by `list_files` and the watcher so every index
/// path derives mtimes the same way.
pub(crate) fn modified_ms(meta: &fs::Metadata) -> Option<u64> {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|dur| dur.as_millis() as u64)
}

/// Collect files under `root/dir` into `out` (recursive). `extension` filters
/// by file extension when set (`Some("md")` for notes); `None` collects every
/// regular file (assets).
pub(super) fn collect_files(
    root: &Path,
    dir: &str,
    extension: Option<&str>,
    out: &mut Vec<FileMeta>,
) -> AppResult<()> {
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
            let matches = extension
                .is_none_or(|ext| path.extension().and_then(|found| found.to_str()) == Some(ext));
            if file_type.is_file() && matches {
                // Skip anything that isn't actually under the root rather than
                // leaking an absolute path.
                let Ok(rel) = path.strip_prefix(root) else {
                    continue;
                };
                let meta = entry.metadata()?;
                out.push(FileMeta {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    size: meta.len(),
                    modified_ms: modified_ms(&meta).unwrap_or(0),
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn bootstrap_creates_layout() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        for sub in TOP_LEVEL_DIRS {
            assert!(dir.path().join(sub).is_dir(), "missing dir {sub}");
        }
        let gitignore = fs::read_to_string(dir.path().join(".gitignore")).unwrap();
        assert!(gitignore.contains("/.reflect/"));
        assert!(gitignore.contains(".DS_Store"));
        assert!(gitignore.contains("Thumbs.db"));
        assert!(gitignore.contains("*.swp"));
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
            collect_files(dir.path(), d, Some("md"), &mut out).unwrap();
        }
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert!(paths.contains(&"notes/a.md"));
        assert!(paths.contains(&"daily/2026-06-09.md"));
        assert!(!paths.iter().any(|p| p.ends_with(".txt")));
    }

    #[test]
    fn unfiltered_collect_lists_every_file_in_a_dir() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        // `audio-memos/` is not bootstrapped — the first write creates it.
        atomic_write_bytes(&dir.path().join("audio-memos/memo.webm"), b"audio").unwrap();
        atomic_write_bytes(&dir.path().join("audio-memos/memo.m4a"), b"audio").unwrap();
        atomic_write(&dir.path().join("notes/a.md"), "a").unwrap();

        let mut out = Vec::new();
        collect_files(dir.path(), "audio-memos", None, &mut out).unwrap();
        let paths: Vec<&str> = out.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths.len(), 2);
        assert!(paths.contains(&"audio-memos/memo.webm"));
        assert!(paths.contains(&"audio-memos/memo.m4a"));
    }

    #[test]
    fn collect_of_a_missing_dir_lists_empty() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();

        let mut out = Vec::new();
        collect_files(dir.path(), "audio-memos", None, &mut out).unwrap();
        assert!(out.is_empty());
    }
}
