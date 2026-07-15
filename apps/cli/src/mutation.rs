//! Shared mutation primitives: graph-contained paths, optimistic hashes,
//! atomic writes, recoverable deletion, and stdin payloads.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::CliError;
use crate::hash::hash_content;
use crate::note_file::parse_note_meta;
use crate::paths::{parse_calendar_date, NOTE_DIRS};

pub const REFLECT_DIR: &str = ".reflect";
pub const TRASH_DIR: &str = ".reflect/trash";

fn lexical_note_path(rel_path: &str) -> Result<PathBuf, CliError> {
    let path = Path::new(rel_path);
    let mut components = path.components();
    let Some(Component::Normal(first)) = components.next() else {
        return Err(CliError::runtime(format!(
            "note path must be graph-relative: {rel_path}"
        )));
    };
    let first = first.to_string_lossy();
    if !NOTE_DIRS.contains(&first.as_ref()) {
        return Err(CliError::runtime(format!(
            "note path must be under daily/, notes/, or templates/: {rel_path}"
        )));
    }
    for component in components {
        if !matches!(component, Component::Normal(_)) {
            return Err(CliError::runtime(format!(
                "note path escapes the graph: {rel_path}"
            )));
        }
    }
    if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
        return Err(CliError::runtime(format!(
            "note path must end in .md: {rel_path}"
        )));
    }
    if first == "daily" {
        let Some(date) = rel_path
            .strip_prefix("daily/")
            .and_then(|path| path.strip_suffix(".md"))
        else {
            return Err(CliError::runtime(format!("invalid daily path: {rel_path}")));
        };
        if date.contains('/') || parse_calendar_date(date).is_none() {
            return Err(CliError::runtime(format!("invalid daily path: {rel_path}")));
        }
    }
    Ok(path.to_path_buf())
}

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

/// Resolve a note path and reject symlink escapes out of the graph.
pub fn resolve_note_path(root: &Path, rel_path: &str) -> Result<PathBuf, CliError> {
    let rel = lexical_note_path(rel_path)?;
    let target = root.join(&rel);
    let canonical_root = root.canonicalize()?;
    let anchor = existing_ancestor(&target).canonicalize()?;
    if !anchor.starts_with(&canonical_root) {
        return Err(CliError::runtime(format!(
            "note path resolves outside the graph: {rel_path}"
        )));
    }
    Ok(target)
}

/// Read an existing public note and optionally verify its expected hash.
pub fn read_for_mutation(
    root: &Path,
    rel_path: &str,
    expected_hash: Option<&str>,
) -> Result<String, CliError> {
    let path = resolve_note_path(root, rel_path)?;
    let source = fs::read_to_string(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            CliError::NotFound(format!("note does not exist: {rel_path}"))
        } else {
            CliError::runtime(format!("could not read {rel_path}: {error}"))
        }
    })?;
    if parse_note_meta(rel_path, &source).private {
        return Err(CliError::Private(format!("note is private: {rel_path}")));
    }
    verify_hash(rel_path, &source, expected_hash)?;
    Ok(source)
}

pub fn verify_hash(
    rel_path: &str,
    source: &str,
    expected_hash: Option<&str>,
) -> Result<(), CliError> {
    let Some(expected_hash) = expected_hash else {
        return Ok(());
    };
    let actual = hash_content(source);
    if actual != expected_hash {
        return Err(CliError::Conflict(format!(
            "note changed since it was read: {rel_path} (expected {expected_hash}, found {actual})"
        )));
    }
    Ok(())
}

fn stage(root: &Path, contents: &[u8]) -> Result<tempfile::NamedTempFile, CliError> {
    let staging = root.join(REFLECT_DIR).join("tmp");
    fs::create_dir_all(&staging)?;
    let mut temp = tempfile::NamedTempFile::new_in(staging)?;
    temp.write_all(contents)?;
    temp.as_file().sync_all()?;
    Ok(temp)
}

/// Atomically replace an existing note after re-checking the expected hash.
pub fn atomic_replace(
    root: &Path,
    rel_path: &str,
    contents: &str,
    expected_hash: Option<&str>,
) -> Result<String, CliError> {
    let target = resolve_note_path(root, rel_path)?;
    let current = read_for_mutation(root, rel_path, expected_hash)?;
    let temp = stage(root, contents.as_bytes())?;
    let latest = fs::read_to_string(&target)
        .map_err(|error| CliError::runtime(format!("could not re-read {rel_path}: {error}")))?;
    if latest != current {
        return Err(CliError::Conflict(format!(
            "note changed while it was being written: {rel_path}"
        )));
    }
    temp.persist(&target)
        .map_err(|error| CliError::runtime(error.error.to_string()))?;
    Ok(hash_content(contents))
}

/// Atomically create a note without replacing an existing path.
pub fn atomic_create(root: &Path, rel_path: &str, contents: &str) -> Result<String, CliError> {
    let target = resolve_note_path(root, rel_path)?;
    if target.exists() {
        return Err(CliError::Conflict(format!(
            "note already exists: {rel_path}"
        )));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = stage(root, contents.as_bytes())?;
    temp.persist_noclobber(&target).map_err(|error| {
        if error.error.kind() == io::ErrorKind::AlreadyExists {
            CliError::Conflict(format!("note already exists: {rel_path}"))
        } else {
            CliError::runtime(error.error.to_string())
        }
    })?;
    Ok(hash_content(contents))
}

/// Read a payload from an option or stdin, requiring exactly one source.
pub fn payload(value: Option<String>, stdin: bool, label: &str) -> Result<String, CliError> {
    match (value, stdin) {
        (Some(value), false) => Ok(value),
        (None, true) => {
            let mut input = String::new();
            io::stdin().read_to_string(&mut input)?;
            Ok(input)
        }
        (Some(_), true) => Err(CliError::runtime(format!(
            "provide either --{label} or --stdin, not both"
        ))),
        (None, false) => Err(CliError::runtime(format!("provide --{label} or --stdin"))),
    }
}

/// Move a public note to another valid graph-relative note path.
pub fn move_note(
    root: &Path,
    from: &str,
    to: &str,
    expected_hash: Option<&str>,
) -> Result<String, CliError> {
    let source = read_for_mutation(root, from, expected_hash)?;
    let from_abs = resolve_note_path(root, from)?;
    let to_abs = resolve_note_path(root, to)?;
    if to_abs.exists() {
        return Err(CliError::Conflict(format!(
            "destination already exists: {to}"
        )));
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    let latest = fs::read_to_string(&from_abs)
        .map_err(|error| CliError::runtime(format!("could not re-read {from}: {error}")))?;
    if latest != source {
        return Err(CliError::Conflict(format!(
            "note changed while it was being moved: {from}"
        )));
    }
    fs::rename(from_abs, to_abs)?;
    Ok(hash_content(&source))
}

fn timestamp_millis() -> Result<u128, CliError> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| CliError::runtime(error.to_string()))?
        .as_millis())
}

/// Move a public note into the graph-local recoverable trash.
pub fn trash_note(
    root: &Path,
    rel_path: &str,
    expected_hash: Option<&str>,
) -> Result<(String, String), CliError> {
    let source = read_for_mutation(root, rel_path, expected_hash)?;
    let from = resolve_note_path(root, rel_path)?;
    let millis = timestamp_millis()?;
    let mut attempt = 0_u32;
    let trash_rel = loop {
        let bucket = if attempt == 0 {
            millis.to_string()
        } else {
            format!("{millis}-{attempt}")
        };
        let candidate = format!("{TRASH_DIR}/{bucket}/{rel_path}");
        if !root.join(&candidate).exists() {
            break candidate;
        }
        attempt += 1;
    };
    let to = root.join(&trash_rel);
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let latest = fs::read_to_string(&from)
        .map_err(|error| CliError::runtime(format!("could not re-read {rel_path}: {error}")))?;
    if latest != source {
        return Err(CliError::Conflict(format!(
            "note changed while it was being deleted: {rel_path}"
        )));
    }
    fs::rename(from, to)?;
    Ok((trash_rel, hash_content(&source)))
}

fn original_path_from_trash(trash_path: &str) -> Option<&str> {
    let rest = trash_path.strip_prefix(&format!("{TRASH_DIR}/"))?;
    let (_, original) = rest.split_once('/')?;
    Some(original)
}

/// Restore a public note from graph-local trash, optionally to a new path.
pub fn restore_note(
    root: &Path,
    trash_path: &str,
    to: Option<&str>,
) -> Result<(String, String), CliError> {
    let original = original_path_from_trash(trash_path)
        .ok_or_else(|| CliError::runtime(format!("invalid trash path: {trash_path}")))?;
    let destination = to.unwrap_or(original);
    let to_abs = resolve_note_path(root, destination)?;
    let trash_abs = root.join(trash_path);
    let canonical_root = root.canonicalize()?;
    let canonical_trash = trash_abs.canonicalize().map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            CliError::NotFound(format!("trashed note does not exist: {trash_path}"))
        } else {
            CliError::runtime(error.to_string())
        }
    })?;
    if !canonical_trash.starts_with(canonical_root.join(TRASH_DIR)) || !canonical_trash.is_file() {
        return Err(CliError::runtime(format!(
            "invalid trash path: {trash_path}"
        )));
    }
    if to_abs.exists() {
        return Err(CliError::Conflict(format!(
            "restore destination already exists: {destination}"
        )));
    }
    let source = fs::read_to_string(&canonical_trash)?;
    if parse_note_meta(destination, &source).private {
        return Err(CliError::Private(format!(
            "trashed note is private: {trash_path}"
        )));
    }
    if let Some(parent) = to_abs.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(canonical_trash, to_abs)?;
    Ok((destination.to_string(), hash_content(&source)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn graph() -> tempfile::TempDir {
        let root = tempdir().unwrap();
        for dir in [REFLECT_DIR, "daily", "notes", "templates"] {
            fs::create_dir_all(root.path().join(dir)).unwrap();
        }
        root
    }

    #[test]
    fn rejects_traversal_and_symlink_escapes() {
        let root = graph();
        assert!(resolve_note_path(root.path(), "../secret.md").is_err());
        assert!(resolve_note_path(root.path(), "assets/a.md").is_err());
        assert!(resolve_note_path(root.path(), "daily/2026-02-31.md").is_err());

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let outside = tempdir().unwrap();
            symlink(outside.path(), root.path().join("notes/escape")).unwrap();
            assert!(resolve_note_path(root.path(), "notes/escape/a.md").is_err());
        }
    }

    #[test]
    fn atomic_write_checks_hash_and_private_state() {
        let root = graph();
        atomic_create(root.path(), "notes/a.md", "# A\n").unwrap();
        let old_hash = hash_content("# A\n");
        atomic_replace(root.path(), "notes/a.md", "# B\n", Some(&old_hash)).unwrap();
        assert!(matches!(
            atomic_replace(root.path(), "notes/a.md", "# C\n", Some(&old_hash)),
            Err(CliError::Conflict(_))
        ));

        atomic_create(
            root.path(),
            "notes/private.md",
            "---\nprivate: true\n---\nsecret\n",
        )
        .unwrap();
        assert!(matches!(
            atomic_replace(root.path(), "notes/private.md", "nope", None),
            Err(CliError::Private(_))
        ));
    }

    #[test]
    fn delete_and_restore_are_recoverable() {
        let root = graph();
        atomic_create(root.path(), "notes/a.md", "# A\n").unwrap();
        let (trash_path, _) = trash_note(root.path(), "notes/a.md", None).unwrap();
        assert!(!root.path().join("notes/a.md").exists());
        assert!(root.path().join(&trash_path).exists());
        let (restored, _) = restore_note(root.path(), &trash_path, None).unwrap();
        assert_eq!(restored, "notes/a.md");
        assert_eq!(
            fs::read_to_string(root.path().join(restored)).unwrap(),
            "# A\n"
        );
    }
}
