//! The conflict archive: `.reflect/conflict-archive/<note-path>/` keeps the
//! full content of versions that a lossy resolution consumed, stamped with
//! their modification time and saving device. Local-only: `.reflect/` never
//! syncs.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

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
        .filter(|ext| !ext.is_empty() && ext.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        .unwrap_or("md");
    let mut target = dir.join(format!("{stem}.{ext}"));
    let mut attempt = 0u32;
    while target.exists() {
        attempt += 1;
        target = dir.join(format!("{stem}~{attempt}.{ext}"));
    }
    crate::fs::atomic_write_bytes(root, &target, bytes)?;
    prune_note(root, rel);
    Ok(())
}

/// Archive one version unless Git history already holds its exact bytes at
/// `rel`: in the `HEAD` tree or in the tracking branch's tree. Returns
/// whether a copy was written.
pub fn archive_unless_in_history(
    root: &Path,
    rel: &str,
    device: Option<&str>,
    modified_ms: u64,
    bytes: &[u8],
) -> AppResult<bool> {
    let oid = git2::Oid::hash_object(git2::ObjectType::Blob, bytes)?;
    if blob_in_history(root, rel, oid) {
        return Ok(false);
    }
    archive_version(root, rel, device, modified_ms, bytes)?;
    Ok(true)
}

fn blob_in_history(root: &Path, rel: &str, oid: git2::Oid) -> bool {
    let Ok(repo) = git2::Repository::open(root) else {
        return false;
    };
    let holds = |reference: git2::Reference<'_>| -> bool {
        reference
            .peel_to_tree()
            .ok()
            .and_then(|tree| tree.get_path(Path::new(rel)).ok())
            .is_some_and(|entry| entry.id() == oid)
    };
    let Ok(head) = repo.head() else {
        return false;
    };
    let tracking = head.shorthand().ok().and_then(|branch| {
        repo.find_reference(&format!("refs/remotes/origin/{branch}"))
            .ok()
    });
    holds(head) || tracking.is_some_and(holds)
}

/// One archived version of a note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedVersion {
    pub name: String,
    pub modified_ms: u64,
    pub device: String,
    pub size: u64,
}

/// The archived versions of a note, newest first. Empty when the note has no
/// archive.
pub fn list(root: &Path, rel: &str) -> AppResult<Vec<ArchivedVersion>> {
    let dir = note_archive_dir(root, rel)
        .ok_or_else(|| AppError::io(format!("invalid archive path: {rel}")))?;
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(Vec::new());
    };
    let mut versions: Vec<(u32, ArchivedVersion)> = Vec::new();
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some((modified_ms, device, attempt)) = parse_archive_name(&name) else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        versions.push((
            attempt,
            ArchivedVersion {
                name,
                modified_ms,
                device,
                size: meta.len(),
            },
        ));
    }
    versions
        .sort_by(|a, b| (b.1.modified_ms, b.0, &b.1.name).cmp(&(a.1.modified_ms, a.0, &a.1.name)));
    Ok(versions.into_iter().map(|(_, version)| version).collect())
}

/// The text of one archived version, named as [`list`] returns it. The
/// entry must be a regular file reached through real directories only.
pub fn read(root: &Path, rel: &str, name: &str) -> AppResult<String> {
    if parse_archive_name(name).is_none() {
        return Err(AppError::io("invalid archive name"));
    }
    let rel_path = crate::fs::ensure_relative(rel)?;
    let mut dir = root.to_path_buf();
    for component in [Path::new(".reflect"), Path::new(ARCHIVE_DIR)]
        .into_iter()
        .chain(rel_path.iter().map(Path::new))
    {
        dir.push(component);
        if !fs::symlink_metadata(&dir)?.is_dir() {
            return Err(AppError::io("the archive path is not a directory"));
        }
    }
    let entry = dir.join(name);
    if !fs::symlink_metadata(&entry)?.is_file() {
        return Err(AppError::io("the archived version is not a regular file"));
    }
    Ok(fs::read_to_string(entry)?)
}

/// `<ms>-<device>[~n].<ext>` → `(ms, device, n)`. Names must match
/// `^[0-9]+-[A-Za-z0-9-]+(~[0-9]+)?\.[A-Za-z0-9]+$`.
fn parse_archive_name(name: &str) -> Option<(u64, String, u32)> {
    let (stem, ext) = name.rsplit_once('.')?;
    if ext.is_empty() || !ext.bytes().all(|byte| byte.is_ascii_alphanumeric()) {
        return None;
    }
    let (stamp, rest) = stem.split_once('-')?;
    let (device, attempt) = match rest.rsplit_once('~') {
        Some((device, attempt)) => {
            if attempt.is_empty() || !attempt.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            (device, attempt.parse().ok()?)
        }
        None => (rest, 0),
    };
    if stamp.is_empty()
        || !stamp.bytes().all(|byte| byte.is_ascii_digit())
        || device.is_empty()
        || !device
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return None;
    }
    Some((stamp.parse().ok()?, device.to_string(), attempt))
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

/// Prune one note's archive: keep its newest [`MAX_PER_NOTE`] versions and
/// drop versions archived more than [`MAX_AGE_MS`] ago. Best-effort.
pub fn prune_note(root: &Path, rel: &str) {
    let Some(dir) = note_archive_dir(root, rel) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut versions: Vec<((u64, u32), PathBuf, Option<SystemTime>)> = Vec::new();
    for entry in entries.flatten() {
        let Some((modified_ms, _, attempt)) =
            entry.file_name().to_str().and_then(parse_archive_name)
        else {
            continue;
        };
        let Ok(meta) = entry.metadata() else {
            continue;
        };
        if meta.is_file() {
            versions.push(((modified_ms, attempt), entry.path(), meta.modified().ok()));
        }
    }
    versions.sort_by_key(|version| std::cmp::Reverse(version.0));
    for (index, (_, path, archived)) in versions.iter().enumerate() {
        let too_old = archived
            .and_then(|archived| now.duration_since(archived).ok())
            .is_some_and(|age| age.as_millis() > u128::from(MAX_AGE_MS));
        if index >= MAX_PER_NOTE || too_old {
            let _ = fs::remove_file(path);
        }
    }
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
    let mut cleaned = String::new();
    for ch in device.unwrap_or("unknown").chars() {
        let ch = if ch.is_ascii_alphanumeric() { ch } else { '-' };
        if ch != '-' || !cleaned.ends_with('-') {
            cleaned.push(ch);
        }
    }
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
        assert_eq!(names, vec!["1000-Alex-s-Mac.md", "1000-Alex-s-Mac~1.md"]);
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
    fn archiving_the_twenty_first_version_drops_the_oldest() {
        let root = tempdir().unwrap();
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        for offset in (0..MAX_PER_NOTE as u64).rev() {
            archive_version(
                root.path(),
                "notes/a.md",
                None,
                now_ms - 100 - offset,
                b"old",
            )
            .unwrap();
        }
        assert_eq!(list(root.path(), "notes/a.md").unwrap().len(), MAX_PER_NOTE);
        let oldest = format!("{}-unknown.md", now_ms - 100 - (MAX_PER_NOTE as u64 - 1));
        assert!(list(root.path(), "notes/a.md")
            .unwrap()
            .iter()
            .any(|version| version.name == oldest));

        archive_version(root.path(), "notes/a.md", None, now_ms, b"newest").unwrap();
        let versions = list(root.path(), "notes/a.md").unwrap();
        assert_eq!(versions.len(), MAX_PER_NOTE);
        assert_eq!(versions[0].name, format!("{now_ms}-unknown.md"));
        assert!(!versions.iter().any(|version| version.name == oldest));
    }

    #[test]
    fn traversal_shapes_are_refused() {
        let root = tempdir().unwrap();
        assert!(archive_version(root.path(), "../escape.md", None, 1, b"x").is_err());
    }

    fn commit_file(repo: &git2::Repository, rel: &str, bytes: &[u8]) -> git2::Oid {
        let path = repo.workdir().unwrap().join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, bytes).unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new(rel)).unwrap();
        let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
        let sig = git2::Signature::now("t", "t@example.com").unwrap();
        let parents: Vec<git2::Commit> = repo
            .head()
            .ok()
            .and_then(|head| head.peel_to_commit().ok())
            .into_iter()
            .collect();
        let parents: Vec<&git2::Commit> = parents.iter().collect();
        repo.commit(Some("HEAD"), &sig, &sig, "c", &tree, &parents)
            .unwrap()
    }

    fn graph_with_git(rel: &str, bytes: &[u8]) -> (tempfile::TempDir, git2::Repository) {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".reflect")).unwrap();
        let repo = git2::Repository::init(root.path()).unwrap();
        commit_file(&repo, rel, bytes);
        (root, repo)
    }

    #[test]
    fn content_in_the_git_odb_is_not_archived() {
        let (root, repo) = graph_with_git("notes/a.md", b"in history");
        let skipped =
            archive_unless_in_history(root.path(), "notes/a.md", None, 1, b"in history").unwrap();
        assert!(!skipped);
        assert!(list(root.path(), "notes/a.md").unwrap().is_empty());

        let written =
            archive_unless_in_history(root.path(), "notes/a.md", None, 2, b"new text").unwrap();
        assert!(written);
        assert_eq!(list(root.path(), "notes/a.md").unwrap().len(), 1);

        // A loose blob that no commit holds at this path is not history.
        repo.blob(b"only an object").unwrap();
        assert!(
            archive_unless_in_history(root.path(), "notes/a.md", None, 3, b"only an object")
                .unwrap()
        );
        // The same bytes committed at another path do not count either.
        assert!(
            archive_unless_in_history(root.path(), "notes/b.md", None, 4, b"in history").unwrap()
        );
    }

    #[test]
    fn the_tracking_branch_tree_counts_as_history() {
        let (root, repo) = graph_with_git("notes/a.md", b"remote text");
        let branch = repo.head().unwrap().shorthand().unwrap().to_string();
        let first = repo.head().unwrap().target().unwrap();
        repo.reference(&format!("refs/remotes/origin/{branch}"), first, true, "t")
            .unwrap();
        commit_file(&repo, "notes/a.md", b"local text");

        assert!(
            !archive_unless_in_history(root.path(), "notes/a.md", None, 1, b"remote text").unwrap()
        );
        assert!(
            !archive_unless_in_history(root.path(), "notes/a.md", None, 2, b"local text").unwrap()
        );
        assert!(
            archive_unless_in_history(root.path(), "notes/a.md", None, 3, b"other text").unwrap()
        );
    }

    #[test]
    fn a_non_ascii_device_name_round_trips() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".reflect")).unwrap();
        archive_version(root.path(), "notes/a.md", Some("Alex的MacBook"), 7, b"cjk").unwrap();
        archive_version(
            root.path(),
            "notes/a.md",
            Some("Alex的MacBook"),
            7,
            b"again",
        )
        .unwrap();
        let versions = list(root.path(), "notes/a.md").unwrap();
        assert_eq!(versions.len(), 2);
        assert_eq!(versions[0].name, "7-Alex-MacBook~1.md");
        assert_eq!(versions[0].device, "Alex-MacBook");
        assert_eq!(versions[1].device, "Alex-MacBook");
        assert_eq!(
            read(root.path(), "notes/a.md", &versions[1].name).unwrap(),
            "cjk"
        );
        assert_eq!(
            read(root.path(), "notes/a.md", &versions[0].name).unwrap(),
            "again"
        );
    }

    #[test]
    fn without_a_repository_everything_is_archived() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".reflect")).unwrap();
        assert!(archive_unless_in_history(root.path(), "notes/a.md", None, 1, b"x").unwrap());
    }

    #[test]
    fn list_returns_newest_first_and_ignores_foreign_names() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".reflect")).unwrap();
        assert!(list(root.path(), "notes/a.md").unwrap().is_empty());
        archive_version(root.path(), "notes/a.md", Some("iPhone"), 100, b"old").unwrap();
        archive_version(root.path(), "notes/a.md", Some("Mac"), 300, b"newest").unwrap();
        archive_version(root.path(), "notes/a.md", Some("Mac"), 300, b"dup").unwrap();
        let dir = root.path().join(".reflect/conflict-archive/notes/a.md");
        fs::write(dir.join("stray.txt"), "x").unwrap();

        let versions = list(root.path(), "notes/a.md").unwrap();
        let names: Vec<&str> = versions.iter().map(|v| v.name.as_str()).collect();
        assert_eq!(names, vec!["300-Mac~1.md", "300-Mac.md", "100-iPhone.md"]);
        assert_eq!(versions[2].modified_ms, 100);
        assert_eq!(versions[2].device, "iPhone");
        assert_eq!(versions[2].size, 3);
    }

    #[test]
    fn read_returns_text_and_refuses_unlisted_shapes() {
        let root = tempdir().unwrap();
        fs::create_dir_all(root.path().join(".reflect")).unwrap();
        archive_version(root.path(), "notes/a.md", Some("Mac"), 5, b"hello").unwrap();
        assert_eq!(
            read(root.path(), "notes/a.md", "5-Mac.md").unwrap(),
            "hello"
        );
        for name in [
            "../5-Mac.md",
            "a/5-Mac.md",
            "5-Mac",
            "x-Mac.md",
            "5-.md",
            "",
        ] {
            assert!(read(root.path(), "notes/a.md", name).is_err(), "{name}");
        }
        assert!(read(root.path(), "../a.md", "5-Mac.md").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_archive_entry_is_refused() {
        use std::os::unix::fs::symlink;

        let root = tempdir().unwrap();
        let outside = tempdir().unwrap();
        fs::write(outside.path().join("secret.md"), "secret").unwrap();
        archive_version(root.path(), "notes/a.md", None, 1000, b"kept").unwrap();
        assert_eq!(
            read(root.path(), "notes/a.md", "1000-unknown.md").unwrap(),
            "kept"
        );

        // A symlinked entry.
        let dir = root.path().join(".reflect/conflict-archive/notes/a.md");
        symlink(
            outside.path().join("secret.md"),
            dir.join("2000-unknown.md"),
        )
        .unwrap();
        assert!(read(root.path(), "notes/a.md", "2000-unknown.md").is_err());

        // A symlinked directory component.
        fs::create_dir_all(outside.path().join("b.md")).unwrap();
        fs::write(outside.path().join("b.md/3000-unknown.md"), "secret").unwrap();
        symlink(
            outside.path().join("b.md"),
            root.path().join(".reflect/conflict-archive/notes/b.md"),
        )
        .unwrap();
        assert!(read(root.path(), "notes/b.md", "3000-unknown.md").is_err());
    }
}
