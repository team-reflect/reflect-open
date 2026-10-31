use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use reflect_types::AppResult;

const STALE_LOCK_MS: u64 = 5 * 60_000;
const GIT_ELOCKED: i32 = -14;

/// Run `f`; when it fails on a lock file a dead process left behind, remove
/// the stale lock and run `f` once more.
pub(super) fn retry_after_stale_lock<T>(root: &Path, f: impl Fn() -> AppResult<T>) -> AppResult<T> {
    let error = match f() {
        Ok(value) => return Ok(value),
        Err(error) => error,
    };
    let message = error.message();
    if error.git_code() != Some(GIT_ELOCKED) && !message.contains("failed to lock file") {
        return Err(error);
    }
    if clear_stale_locks(root, message) == 0 {
        return Err(error);
    }
    f()
}

pub(super) fn clear_stale_locks(root: &Path, message: &str) -> usize {
    let Ok(repo) = git2::Repository::open(root) else {
        return 0;
    };
    if let Some(path) = parse_lock_path(message)
        && is_repository_lock(&repo, &path)
        && remove_if_stale(&path)
    {
        return 1;
    }
    sweep(&repo)
}

fn parse_lock_path(message: &str) -> Option<PathBuf> {
    let rest = &message[message.find('\'')? + 1..];
    let path = &rest[..rest.find('\'')?];
    (!path.is_empty()).then(|| PathBuf::from(path))
}

/// An absolute `.lock` path inside the git directory or the common directory.
fn is_repository_lock(repo: &git2::Repository, path: &Path) -> bool {
    path.is_absolute()
        && path.extension().is_some_and(|ext| ext == "lock")
        && (path.starts_with(repo.path()) || path.starts_with(repo.commondir()))
}

fn is_stale(modified: SystemTime) -> bool {
    let age = match SystemTime::now().duration_since(modified) {
        Ok(age) => age,
        Err(ahead) => ahead.duration(),
    };
    age > Duration::from_millis(STALE_LOCK_MS)
}

fn remove_if_stale(path: &Path) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.file_type().is_file() {
        return false;
    }
    if !metadata.modified().is_ok_and(is_stale) {
        return false;
    }
    match fs::remove_file(path) {
        Ok(()) => {
            tracing::warn!(path = %path.display(), "removed a stale git lock file");
            true
        }
        Err(_) => false,
    }
}

fn sweep(repo: &git2::Repository) -> usize {
    let mut dirs = vec![repo.path().to_path_buf()];
    if repo.commondir() != repo.path() {
        dirs.push(repo.commondir().to_path_buf());
    }
    let mut removed = 0;
    for dir in dirs {
        removed += sweep_dir(&dir, false);
        removed += sweep_dir(&dir.join("refs"), true);
    }
    removed
}

fn sweep_dir(dir: &Path, recursive: bool) -> usize {
    let Ok(metadata) = fs::symlink_metadata(dir) else {
        return 0;
    };
    if !metadata.file_type().is_dir() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            if recursive {
                removed += sweep_dir(&path, true);
            }
        } else if file_type.is_file()
            && path.extension().is_some_and(|ext| ext == "lock")
            && remove_if_stale(&path)
        {
            removed += 1;
        }
    }
    removed
}
