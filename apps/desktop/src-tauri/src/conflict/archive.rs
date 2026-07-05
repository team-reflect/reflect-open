//! The conflict archive: `.reflect/conflict-archive/<note-path>/` keeps the
//! full content of every version a resolution consumed, stamped with its
//! modification time and saving device. Resolution must never be the only
//! copy-holder — `removeOtherVersionsOfItem` is called strictly after the
//! archive write lands (Plan 21 layer 3). Local-only: `.reflect/` never syncs.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{AppError, AppResult};

const ARCHIVE_DIR: &str = "conflict-archive";

/// How many archived versions to keep per note, newest first.
const MAX_PER_NOTE: usize = 20;
/// Archived versions older than this are pruned regardless of count.
const MAX_AGE_MS: u64 = 90 * 24 * 60 * 60 * 1000;

/// Archive one version's full content before it is resolved away.
pub fn archive_version(
    root: &Path,
    rel: &str,
    device: Option<&str>,
    modified_ms: u64,
    bytes: &[u8],
) -> AppResult<()> {
    let dir = note_archive_dir(root, rel)
        .ok_or_else(|| AppError::io(format!("invalid archive path: {rel}")))?;
    fs::create_dir_all(&dir)?;
    let stem = format!("{modified_ms}-{}", sanitize_device(device));
    let ext = Path::new(rel)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("md");
    let mut target = dir.join(format!("{stem}.{ext}"));
    let mut attempt = 0u32;
    while target.exists() {
        attempt += 1;
        target = dir.join(format!("{stem}-{attempt}.{ext}"));
    }
    crate::fs::atomic_write_bytes(root, &target, bytes)?;
    Ok(())
}

/// Prune the archive: per note, keep the newest [`MAX_PER_NOTE`] versions and
/// drop anything older than [`MAX_AGE_MS`]. Best-effort — pruning must never
/// fail a sweep.
pub fn prune(root: &Path) {
    let archive = root.join(".reflect").join(ARCHIVE_DIR);
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0);
    prune_dir(&archive, now_ms);
}

fn prune_dir(dir: &Path, now_ms: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            prune_dir(&path, now_ms);
            // A directory emptied by pruning (or already empty) goes too.
            let _ = fs::remove_dir(&path);
        } else {
            files.push(path);
        }
    }
    // Names sort by their epoch-ms prefix; same-width stamps order correctly
    // for any realistic timeline, and mis-sorting only reorders what to keep.
    files.sort();
    files.reverse(); // newest first
    for (index, file) in files.iter().enumerate() {
        let stamp = file
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.split('-').next())
            .and_then(|stamp| stamp.parse::<u64>().ok())
            .unwrap_or(0);
        let too_old = now_ms.saturating_sub(stamp) > MAX_AGE_MS;
        if index >= MAX_PER_NOTE || too_old {
            let _ = fs::remove_file(file);
        }
    }
}

/// `notes/a.md` → `<root>/.reflect/conflict-archive/notes/a.md/` (the note
/// path becomes a directory). Refuses whatever the shared traversal guard
/// refuses ([`crate::fs::ensure_relative`]).
fn note_archive_dir(root: &Path, rel: &str) -> Option<PathBuf> {
    crate::fs::ensure_relative(rel).ok()?;
    Some(root.join(".reflect").join(ARCHIVE_DIR).join(rel))
}

fn sanitize_device(device: Option<&str>) -> String {
    let cleaned: String = device
        .unwrap_or("unknown")
        .chars()
        .map(|ch| if ch.is_alphanumeric() { ch } else { '-' })
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn archives_versions_without_clobbering_same_stamp_entries() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".reflect")).unwrap();
        archive_version(root.path(), "notes/a.md", Some("Alex's Mac"), 1000, b"one").unwrap();
        archive_version(root.path(), "notes/a.md", Some("Alex's Mac"), 1000, b"two").unwrap();
        let dir = root.path().join(".reflect/conflict-archive/notes/a.md");
        let mut names: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(names, vec!["1000-Alex-s-Mac-1.md", "1000-Alex-s-Mac.md"]);
    }

    #[test]
    fn prune_drops_old_and_excess_versions_and_empty_dirs() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".reflect")).unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        // One ancient entry plus more-than-max recent ones.
        archive_version(root.path(), "notes/a.md", None, 1, b"ancient").unwrap();
        for offset in 0..(MAX_PER_NOTE as u64 + 3) {
            archive_version(root.path(), "notes/a.md", None, now_ms - offset, b"recent").unwrap();
        }
        prune(root.path());
        let dir = root.path().join(".reflect/conflict-archive/notes/a.md");
        let count = fs::read_dir(&dir).unwrap().count();
        assert_eq!(count, MAX_PER_NOTE);
        assert!(!dir.join("1-unknown.md").exists(), "ancient entry survived");

        // A note dir whose entries all pruned away disappears entirely.
        archive_version(root.path(), "notes/b.md", None, 2, b"ancient").unwrap();
        prune(root.path());
        assert!(!root
            .path()
            .join(".reflect/conflict-archive/notes/b.md")
            .exists());
    }

    #[test]
    fn traversal_shapes_are_refused() {
        let root = tempdir().unwrap();
        assert!(archive_version(root.path(), "../escape.md", None, 1, b"x").is_err());
    }
}
