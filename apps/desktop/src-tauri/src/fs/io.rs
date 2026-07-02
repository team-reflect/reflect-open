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
#[cfg(target_os = "macos")]
const APPLE_EXCLUSION_KEYS: [&str; 2] = [
    "NSURLUbiquitousItemIsExcludedFromSyncKey",
    "NSURLIsExcludedFromBackupKey",
];
#[cfg(target_os = "macos")]
const LOCAL_ONLY_XATTRS: [(&str, &[u8]); 2] = [
    ("com.apple.fileprovider.ignore#P", b"1"),
    ("com.dropbox.ignored", b"1"),
];
/// Directories scanned by `list_files` for markdown notes.
pub(super) const NOTE_DIRS: [&str; 2] = ["daily", "notes"];

/// Create the standard graph layout + ignore/meta files (idempotent).
pub(super) fn bootstrap(root: &Path) -> AppResult<()> {
    for dir in TOP_LEVEL_DIRS {
        fs::create_dir_all(root.join(dir))?;
    }
    sweep_upload_staging(root);
    mark_reflect_dir_local_only(&root.join(REFLECT_DIR));
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

/// Drop leftover upload staging files (`.reflect/tmp/`, see `fs::assets`) —
/// a crash mid-upload strands its temp file, and nothing else ever reclaims
/// it. Opening the graph is the natural sweep point: a generation bump
/// rejects any commit that was still in flight, so nothing live is removed.
/// Best-effort — a locked file must not fail the open.
fn sweep_upload_staging(root: &Path) {
    let staging = root.join(REFLECT_DIR).join("tmp");
    if !staging.exists() {
        return;
    }
    if let Err(err) = fs::remove_dir_all(&staging) {
        tracing::warn!(path = %staging.display(), %err, "failed to sweep upload staging");
    }
}

#[cfg(not(target_os = "macos"))]
fn mark_reflect_dir_local_only(_reflect_dir: &Path) {}

#[cfg(target_os = "macos")]
fn mark_reflect_dir_local_only(reflect_dir: &Path) {
    for err in set_apple_sync_exclusions(reflect_dir) {
        tracing::warn!(
            path = %reflect_dir.display(),
            %err,
            "failed to mark .reflect as excluded from Apple sync"
        );
    }
    for err in set_local_only_xattrs(reflect_dir) {
        tracing::warn!(
            path = %reflect_dir.display(),
            %err,
            "failed to mark .reflect with provider ignore attributes"
        );
    }
}

#[cfg(target_os = "macos")]
fn set_apple_sync_exclusions(reflect_dir: &Path) -> Vec<String> {
    use core_foundation::base::TCFType;
    use core_foundation::{number, string, url};
    use std::ptr;

    let Some(reflect_url) = url::CFURL::from_path(reflect_dir, true) else {
        return vec![format!("invalid path: {}", reflect_dir.display())];
    };
    let mut errors = Vec::new();

    for key_name in APPLE_EXCLUSION_KEYS {
        let Ok(key) = key_name.parse::<string::CFString>() else {
            errors.push(format!("invalid resource key: {key_name}"));
            continue;
        };
        let ok = unsafe {
            url::CFURLSetResourcePropertyForKey(
                reflect_url.as_concrete_TypeRef(),
                key.as_concrete_TypeRef(),
                number::kCFBooleanTrue as *const _,
                ptr::null_mut(),
            )
        };
        if ok == 0 {
            errors.push(format!("failed to set {key_name}"));
        }
    }

    errors
}

#[cfg(target_os = "macos")]
fn set_local_only_xattrs(reflect_dir: &Path) -> Vec<String> {
    let mut errors = Vec::new();

    for (name, value) in LOCAL_ONLY_XATTRS {
        if let Err(err) = xattr::set(reflect_dir, name, value) {
            errors.push(format!("failed to set {name}: {err}"));
        }
    }

    errors
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

    #[cfg(target_os = "macos")]
    #[test]
    fn bootstrap_marks_reflect_dir_with_provider_ignore_xattrs() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let reflect_dir = dir.path().join(REFLECT_DIR);
        assert_eq!(
            xattr::get(&reflect_dir, "com.apple.fileprovider.ignore#P").unwrap(),
            Some(b"1".to_vec())
        );
        assert_eq!(
            xattr::get(&reflect_dir, "com.dropbox.ignored").unwrap(),
            Some(b"1".to_vec())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn apple_sync_exclusion_accepts_reflect_dir() {
        let dir = tempdir().unwrap();
        let reflect_dir = dir.path().join(REFLECT_DIR);
        fs::create_dir_all(&reflect_dir).unwrap();
        assert!(set_apple_sync_exclusions(&reflect_dir).is_empty());
    }

    #[test]
    fn bootstrap_sweeps_stale_upload_staging() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        let staging = dir.path().join(".reflect/tmp");
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join(".tmpAbC123"), b"stranded upload").unwrap();
        // Re-opening the graph re-bootstraps; the stranded file goes away.
        bootstrap(dir.path()).unwrap();
        assert!(!staging.exists());
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
