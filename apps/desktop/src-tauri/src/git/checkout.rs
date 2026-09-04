use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};

use git2::{Oid, Repository, Tree};

use crate::error::{AppError, AppResult};

use super::repo::{current_branch, is_runtime, signature};

struct Change {
    path: String,
    before: Option<Oid>,
    after: Option<Oid>,
    executable: bool,
    moved: bool,
    installed: bool,
}

/// Install a prepared tree without ever truncating an existing worktree file.
/// Originals are moved to a persistent recovery directory before a no-clobber
/// claim. This also preserves writes through an external writer's open file
/// descriptor. HEAD moves last; failures restore the index and worktree without
/// overwriting a racing writer. A crash marker prevents committing a partial pull.
pub(super) fn install(
    repo: &Repository,
    root: &Path,
    branch: &str,
    expected: Option<Oid>,
    target: Oid,
    old: Option<&Tree<'_>>,
    new: &Tree<'_>,
) -> AppResult<()> {
    let mut changes = plan(repo, root, old, new)?;
    let refname = format!("refs/heads/{branch}");
    let mut transaction = repo.transaction()?;
    transaction.lock_ref("HEAD")?;
    transaction.lock_ref(&refname)?;
    if current_branch(repo)? != branch || repo.refname_to_id(&refname).ok() != expected {
        return Err(AppError::io("Git HEAD changed during sync; retry"));
    }
    let lock_path = repo.path().join("index.lock");
    let index_lock = File::options()
        .write(true)
        .create_new(true)
        .open(&lock_path)?;
    let _lock = IndexLock {
        path: lock_path,
        _file: index_lock,
    };
    let current_index = repo.index()?.write_tree()?;
    let empty = git2::Index::new()?.write_tree_to(repo)?;
    if current_index != old.map_or(empty, Tree::id) {
        return Err(AppError::io("Git index changed during sync; retry"));
    }
    let recovery_root = repo.path().join("reflect-sync");
    fs::create_dir_all(&recovery_root)?;
    let recovery = tempfile::Builder::new()
        .prefix("checkout-")
        .tempdir_in(&recovery_root)?
        .keep();
    let pending = recovery_root.join("pending");
    let index_path = repo.path().join("index");
    let old_index = match fs::read(&index_path) {
        Ok(bytes) => Some(bytes),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error.into()),
    };
    if let Some(bytes) = &old_index {
        write_synced(&recovery.join("index-before"), bytes)?;
    }
    let manifest = serde_json::json!({
        "branch": branch,
        "before": expected.map(|oid| oid.to_string()),
        "after": target.to_string(),
        "paths": changes.iter().map(|change| &change.path).collect::<Vec<_>>(),
    });
    write_synced(
        &recovery.join("manifest.json"),
        &serde_json::to_vec_pretty(&manifest).map_err(|error| AppError::io(error.to_string()))?,
    )?;
    write_synced(&pending, recovery.to_string_lossy().as_bytes())?;

    let mut index_written = false;
    let result: AppResult<()> = (|| {
        apply(repo, root, &recovery, &mut changes, |_, _| Ok(()))?;
        let mut prepared_index = git2::Index::open(&recovery.join("index-after"))?;
        prepared_index.read_tree(new)?;
        prepared_index.write()?;
        replace_file(&index_path, &fs::read(recovery.join("index-after"))?)?;
        index_written = true;
        let sig = signature(repo)?;
        transaction.set_target(&refname, target, Some(&sig), "reflect sync")?;
        transaction.commit()?;
        Ok(())
    })();

    if let Err(error) = result {
        if index_written && repo.refname_to_id(&refname).ok() == Some(target) {
            fs::remove_file(pending)?;
            return Ok(());
        }
        let rollback = (|| {
            if index_written {
                match old_index {
                    Some(bytes) => replace_file(&index_path, &bytes)?,
                    None => fs::remove_file(&index_path)?,
                }
            }
            restore(root, &recovery, &changes)?;
            fs::remove_file(&pending)?;
            Ok::<_, AppError>(())
        })();
        return Err(AppError::io(format!(
            "Git sync failed: {error:?}. Recovery files: {}. {}",
            recovery.display(),
            if rollback.is_ok() {
                "HEAD and index are unchanged; retry after checking local files".to_string()
            } else {
                format!("Recovery needs attention: {rollback:?}; do not reset --hard")
            }
        )));
    }
    fs::remove_file(pending)?;
    Ok(())
}

/// Preflight the complete diff so predictable failures happen before any move.
fn plan(
    repo: &Repository,
    root: &Path,
    old: Option<&Tree<'_>>,
    new: &Tree<'_>,
) -> AppResult<Vec<Change>> {
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    let mut changes = Vec::new();
    for delta in diff.deltas() {
        let file = if delta.status() == git2::Delta::Deleted {
            delta.old_file()
        } else {
            delta.new_file()
        };
        let path = file
            .path()
            .and_then(Path::to_str)
            .ok_or_else(|| AppError::io("unsupported Git path"))?;
        if is_runtime(path.as_bytes()) {
            continue;
        }
        checked_path(root, path)?;
        for side in [delta.old_file(), delta.new_file()] {
            if !side.id().is_zero()
                && !matches!(
                    side.mode(),
                    git2::FileMode::Blob | git2::FileMode::BlobExecutable
                )
            {
                return Err(AppError::io(format!(
                    "Git sync refuses non-regular file: {path}"
                )));
            }
        }
        let mut before = (!delta.old_file().id().is_zero()).then(|| delta.old_file().id());
        let after = (!delta.new_file().id().is_zero()).then(|| delta.new_file().id());
        if before.is_none() && after.is_some() && fs::symlink_metadata(root.join(path)).is_ok() {
            verify(repo, &root.join(path), after)?;
            before = after;
        }
        verify(repo, &root.join(path), before)?;
        changes.push(Change {
            path: path.to_owned(),
            before,
            after,
            executable: delta.new_file().mode() == git2::FileMode::BlobExecutable,
            moved: false,
            installed: false,
        });
    }
    Ok(changes)
}

/// Keep displaced inodes alive and atomically claim replacements, never truncate.
fn apply(
    repo: &Repository,
    root: &Path,
    recovery: &Path,
    changes: &mut [Change],
    mut boundary: impl FnMut(&str, &str) -> AppResult<()>,
) -> AppResult<()> {
    for change in changes {
        boundary(&change.path, "before")?;
        let target = checked_path(root, &change.path)?;
        verify(repo, &target, change.before)?;
        if change.before.is_some() {
            let original = recovery.join("original").join(&change.path);
            fs::create_dir_all(
                original
                    .parent()
                    .ok_or_else(|| AppError::io("missing recovery parent"))?,
            )?;
            fs::rename(&target, &original)?;
            change.moved = true;
            sync_parent(&original)?;
            sync_parent(&target)?;
            boundary(&change.path, "moved")?;
            verify(repo, &original, change.before)?;
        }
        if let Some(after) = change.after {
            fs::create_dir_all(
                target
                    .parent()
                    .ok_or_else(|| AppError::io("missing checkout parent"))?,
            )?;
            let mut staged = tempfile::NamedTempFile::new_in(recovery)?;
            staged.write_all(repo.find_blob(after)?.content())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                staged
                    .as_file()
                    .set_permissions(fs::Permissions::from_mode(if change.executable {
                        0o755
                    } else {
                        0o644
                    }))?;
            }
            staged.as_file().sync_all()?;
            boundary(&change.path, "claim")?;
            staged.persist_noclobber(&target).map_err(|error| {
                AppError::io(format!("checkout refused {}: {}", change.path, error.error))
            })?;
            change.installed = true;
            sync_parent(&target)?;
        }
        boundary(&change.path, "installed")?;
    }
    Ok(())
}

/// Roll back in reverse order while retaining any file another writer installed.
fn restore(root: &Path, recovery: &Path, changes: &[Change]) -> AppResult<()> {
    for change in changes.iter().rev() {
        let target = checked_path(root, &change.path)?;
        if change.installed && fs::symlink_metadata(&target).is_ok() {
            let displaced = recovery.join("displaced").join(&change.path);
            fs::create_dir_all(
                displaced
                    .parent()
                    .ok_or_else(|| AppError::io("missing recovery parent"))?,
            )?;
            fs::rename(&target, displaced)?;
        }
        if change.moved {
            match fs::hard_link(recovery.join("original").join(&change.path), &target) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
        }
    }
    Ok(())
}

/// Compare bytes, not stat-cache hints, before risking a working-tree replacement.
fn verify(repo: &Repository, path: &Path, expected: Option<Oid>) -> AppResult<()> {
    let matches = match (fs::symlink_metadata(path), expected) {
        (Ok(metadata), Some(expected)) if metadata.is_file() => {
            let blob = repo.find_blob(expected)?;
            metadata.len() == blob.size() as u64 && fs::read(path)? == blob.content()
        }
        (Err(error), None) if error.kind() == std::io::ErrorKind::NotFound => true,
        (Err(error), _) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
        _ => false,
    };
    if !matches {
        return Err(AppError::io(format!(
            "file changed during Git sync; preserved locally: {}",
            path.display()
        )));
    }
    Ok(())
}

/// Refuse paths that could redirect an installation into metadata or symlinks.
fn checked_path(root: &Path, path: &str) -> AppResult<PathBuf> {
    if path.contains('\\') || path.contains(':') {
        return Err(AppError::io(format!(
            "Git sync refuses non-portable path: {path}"
        )));
    }
    let relative = crate::fs::ensure_relative(path)?;
    let mut target = root.to_path_buf();
    for component in relative.components() {
        let name = component.as_os_str().to_string_lossy();
        if name
            .trim_end_matches([' ', '.'])
            .eq_ignore_ascii_case(".git")
        {
            return Err(AppError::io(format!(
                "Git sync refuses repository metadata: {path}"
            )));
        }
        target.push(component);
        if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(AppError::io(format!("Git sync refuses symlink: {path}")));
        }
    }
    Ok(target)
}

/// Establish recovery evidence before starting any destructive rename.
fn write_synced(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut file = File::options().create_new(true).write(true).open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    sync_parent(path)?;
    Ok(())
}

/// Persist directory-entry updates where directory fsync is supported.
fn sync_parent(path: &Path) -> AppResult<()> {
    #[cfg(unix)]
    File::open(
        path.parent()
            .ok_or_else(|| AppError::io("missing parent directory"))?,
    )?
    .sync_all()?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Replace an index as a complete file while the caller holds index.lock.
fn replace_file(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let mut staged = tempfile::NamedTempFile::new_in(
        path.parent()
            .ok_or_else(|| AppError::io("missing index parent"))?,
    )?;
    staged.write_all(bytes)?;
    staged.as_file().sync_all()?;
    staged
        .persist(path)
        .map_err(|error| AppError::io(error.error.to_string()))?;
    Ok(())
}

struct IndexLock {
    path: PathBuf,
    _file: File,
}

impl Drop for IndexLock {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trees(root: &Path) -> (Repository, Oid, Oid) {
        Repository::init(root).unwrap();
        fs::write(root.join("a.md"), b"old a").unwrap();
        fs::write(root.join("b.md"), b"old b").unwrap();
        super::super::commit::commit_all(root, "before", u64::MAX).unwrap();
        let repo = Repository::open(root).unwrap();
        let before = repo.head().unwrap().target().unwrap();
        fs::write(root.join("a.md"), b"new a").unwrap();
        fs::write(root.join("b.md"), b"new b").unwrap();
        super::super::commit::commit_all(root, "after", u64::MAX).unwrap();
        let after = repo.head().unwrap().target().unwrap();
        repo.reset(
            &repo.find_object(before, None).unwrap(),
            git2::ResetType::Hard,
            None,
        )
        .unwrap();
        (repo, before, after)
    }

    #[test]
    fn a_save_after_preflight_is_refused_without_changing_the_saved_bytes() {
        let root = tempfile::tempdir().unwrap();
        let recovery = tempfile::tempdir_in(root.path()).unwrap();
        let (repo, before, after) = trees(root.path());
        let old = repo.find_commit(before).unwrap().tree().unwrap();
        let new = repo.find_commit(after).unwrap().tree().unwrap();
        let mut changes = plan(&repo, root.path(), Some(&old), &new).unwrap();
        let result = apply(
            &repo,
            root.path(),
            recovery.path(),
            &mut changes,
            |path, boundary| {
                if path == "a.md" && boundary == "before" {
                    fs::write(root.path().join(path), b"saved after preflight")?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        restore(root.path(), recovery.path(), &changes).unwrap();
        assert_eq!(
            fs::read(root.path().join("a.md")).unwrap(),
            b"saved after preflight"
        );
        assert_eq!(repo.head().unwrap().target(), Some(before));
    }

    #[test]
    fn an_atomic_save_between_move_and_claim_wins_without_clobbering_either_version() {
        let root = tempfile::tempdir().unwrap();
        let recovery = tempfile::tempdir_in(root.path()).unwrap();
        let (repo, before, after) = trees(root.path());
        let old = repo.find_commit(before).unwrap().tree().unwrap();
        let new = repo.find_commit(after).unwrap().tree().unwrap();
        let mut changes = plan(&repo, root.path(), Some(&old), &new).unwrap();
        let result = apply(
            &repo,
            root.path(),
            recovery.path(),
            &mut changes,
            |path, boundary| {
                if path == "a.md" && boundary == "moved" {
                    fs::write(root.path().join(path), b"external atomic save")?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        restore(root.path(), recovery.path(), &changes).unwrap();
        assert_eq!(
            fs::read(root.path().join("a.md")).unwrap(),
            b"external atomic save"
        );
        assert_eq!(
            fs::read(recovery.path().join("original/a.md")).unwrap(),
            b"old a"
        );
    }

    #[test]
    fn partial_install_rollback_retains_a_racing_edit_and_restores_originals() {
        let root = tempfile::tempdir().unwrap();
        let recovery = tempfile::tempdir_in(root.path()).unwrap();
        let (repo, before, after) = trees(root.path());
        let old = repo.find_commit(before).unwrap().tree().unwrap();
        let new = repo.find_commit(after).unwrap().tree().unwrap();
        let mut changes = plan(&repo, root.path(), Some(&old), &new).unwrap();
        let result = apply(
            &repo,
            root.path(),
            recovery.path(),
            &mut changes,
            |path, boundary| {
                if path == "b.md" && boundary == "before" {
                    fs::write(root.path().join("a.md"), b"external edit after install")?;
                    return Err(AppError::io("injected second-file failure"));
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        restore(root.path(), recovery.path(), &changes).unwrap();
        assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"old a");
        assert_eq!(fs::read(root.path().join("b.md")).unwrap(), b"old b");
        assert_eq!(
            fs::read(recovery.path().join("displaced/a.md")).unwrap(),
            b"external edit after install"
        );
        assert_eq!(repo.head().unwrap().target(), Some(before));
        assert_eq!(repo.index().unwrap().write_tree().unwrap(), old.id());
    }

    #[test]
    fn writes_through_an_old_descriptor_remain_recoverable_after_success() {
        let root = tempfile::tempdir().unwrap();
        let recovery = tempfile::tempdir_in(root.path()).unwrap();
        let (repo, before, after) = trees(root.path());
        let old = repo.find_commit(before).unwrap().tree().unwrap();
        let new = repo.find_commit(after).unwrap().tree().unwrap();
        let mut changes = plan(&repo, root.path(), Some(&old), &new).unwrap();
        let mut external = File::options()
            .write(true)
            .open(root.path().join("a.md"))
            .unwrap();
        apply(&repo, root.path(), recovery.path(), &mut changes, |_, _| {
            Ok(())
        })
        .unwrap();
        external.write_all(b"late descriptor save").unwrap();
        assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"new a");
        assert_eq!(
            fs::read(recovery.path().join("original/a.md")).unwrap(),
            b"late descriptor save"
        );
    }

    #[test]
    fn an_existing_index_lock_refuses_before_touching_head_or_worktree() {
        let root = tempfile::tempdir().unwrap();
        let (repo, before, after) = trees(root.path());
        let old = repo.find_commit(before).unwrap().tree().unwrap();
        let new = repo.find_commit(after).unwrap().tree().unwrap();
        fs::write(repo.path().join("index.lock"), b"external git").unwrap();
        let branch = current_branch(&repo).unwrap();
        assert!(install(
            &repo,
            root.path(),
            &branch,
            Some(before),
            after,
            Some(&old),
            &new
        )
        .is_err());
        assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"old a");
        assert_eq!(
            fs::read(repo.path().join("index.lock")).unwrap(),
            b"external git"
        );
        assert_eq!(repo.head().unwrap().target(), Some(before));
    }

    #[test]
    fn interrupted_checkout_blocks_future_commits_without_touching_notes() {
        let root = tempfile::tempdir().unwrap();
        let (repo, before, _) = trees(root.path());
        fs::create_dir_all(repo.path().join("reflect-sync")).unwrap();
        fs::write(repo.path().join("reflect-sync/pending"), b"recovery path").unwrap();
        assert!(super::super::commit::commit_all(root.path(), "retry", u64::MAX).is_err());
        assert_eq!(repo.head().unwrap().target(), Some(before));
        assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"old a");
    }

    #[test]
    fn a_conflict_copy_arriving_at_the_final_claim_is_not_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let recovery = tempfile::tempdir_in(root.path()).unwrap();
        let (repo, _, _) = trees(root.path());
        let mut changes = vec![Change {
            path: "assets/img (conflict).bin".to_owned(),
            before: None,
            after: Some(repo.blob(b"remote image\0").unwrap()),
            executable: false,
            moved: false,
            installed: false,
        }];
        let result = apply(
            &repo,
            root.path(),
            recovery.path(),
            &mut changes,
            |path, boundary| {
                if boundary == "claim" {
                    fs::write(root.path().join(path), b"late intentional attachment\0")?;
                }
                Ok(())
            },
        );
        assert!(result.is_err());
        restore(root.path(), recovery.path(), &changes).unwrap();
        assert_eq!(
            fs::read(root.path().join(&changes[0].path)).unwrap(),
            b"late intentional attachment\0"
        );
    }

    #[cfg(unix)]
    #[test]
    fn failed_multi_file_install_restores_head_index_and_worktree() {
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let (repo, before, after) = trees(root.path());
        let old = repo.find_commit(before).unwrap().tree().unwrap();
        let mut index = git2::Index::new().unwrap();
        index
            .read_tree(&repo.find_commit(after).unwrap().tree().unwrap())
            .unwrap();
        let mut entry = index.get_path(Path::new("a.md"), 0).unwrap();
        entry.path = b"z/new.md".to_vec();
        index.add(&entry).unwrap();
        let new = repo.find_tree(index.write_tree_to(&repo).unwrap()).unwrap();
        let sig = signature(&repo).unwrap();
        let target = repo
            .commit(
                None,
                &sig,
                &sig,
                "incoming",
                &new,
                &[&repo.find_commit(before).unwrap()],
            )
            .unwrap();
        let index_before = fs::read(repo.path().join("index")).unwrap();
        fs::create_dir(root.path().join("z")).unwrap();
        fs::set_permissions(root.path().join("z"), fs::Permissions::from_mode(0o555)).unwrap();
        let result = install(
            &repo,
            root.path(),
            &current_branch(&repo).unwrap(),
            Some(before),
            target,
            Some(&old),
            &new,
        );
        fs::set_permissions(root.path().join("z"), fs::Permissions::from_mode(0o755)).unwrap();
        assert!(result.is_err());
        assert_eq!(repo.head().unwrap().target(), Some(before));
        assert_eq!(fs::read(repo.path().join("index")).unwrap(), index_before);
        assert_eq!(fs::read(root.path().join("a.md")).unwrap(), b"old a");
        assert_eq!(fs::read(root.path().join("b.md")).unwrap(), b"old b");
        assert!(!repo.path().join("reflect-sync/pending").exists());
        install(
            &repo,
            root.path(),
            &current_branch(&repo).unwrap(),
            Some(before),
            target,
            Some(&old),
            &new,
        )
        .unwrap();
        assert_eq!(repo.head().unwrap().target(), Some(target));
    }
}
