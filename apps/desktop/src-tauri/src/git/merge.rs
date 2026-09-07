//! Pull-side merge: fast-forward when possible, otherwise merge — and when
//! the merge conflicts, materialize the conflict **into the note** (standard
//! Git markers with readable labels), commit the merge anyway, and let the
//! user resolve by editing the file.
//!
//! The repository is never left mid-merge: committing the conflict keeps sync
//! flowing for every other note, both devices converge on the same marked-up
//! file, and the raw versions stay recoverable from history (the merge commit
//! has both parents). The indexer (Plan 12 core) detects the markers and flags
//! the note `Needs review`.
//!
//! The markers are standard Git, with product labels instead of branch names:
//!
//! ```text
//! <<<<<<< this device
//! the local version
//! =======
//! the other device's version
//! >>>>>>> other device
//! ```

use std::fs;
use std::io::Write;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, MergeFileInput, MergeFileOptions, Repository};
use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::repo::{current_branch, ensure_clean_state, open_existing, signature};
use super::runtime::{is_runtime_path, remove_from_index, without_runtime};

/// Conflict-marker labels. "this device" is the local side, "other device"
/// the remote one — product language, not branch names.
const OUR_LABEL: &str = "this device";
const THEIR_LABEL: &str = "other device";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merged,
    MergedWithConflicts,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    Upsert,
    Remove,
}

/// One working-tree file a merge/fast-forward rewrote, in the same shape as
/// the watcher's `FileChange` so the caller can reindex directly.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub kind: ChangeKind,
    /// Last-modified time of the written file (epoch ms; upserts only), so
    /// the reindex stamps the real mtime like the watcher path does.
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeOutcome {
    pub kind: MergeKind,
    /// Graph-relative paths that now carry conflict markers (or a binary
    /// conflict copy). Informational — the indexer rediscovers them from
    /// content.
    pub conflicted_paths: Vec<String>,
    /// Every file this merge changed on disk. The sync layer reindexes these
    /// directly — pulls must not depend on the file watcher being up (on
    /// launch it may not be yet) to keep the index in step with the notes.
    /// Deletions carry `modified_ms: None`; upserts carry the written file's
    /// real mtime.
    pub changed_files: Vec<ChangedFile>,
    /// Saves withheld by the size guard during the commit immediately before merge.
    pub skipped_large_files: Vec<super::commit::SkippedFile>,
}

/// Merge the fetched `origin/<branch>` into the local branch. The native
/// wrapper commits pending saves under the same worktree mutation lock held
/// throughout this call. Safe checkout also rejects conflicting dirty files
/// left by the size guard or another filesystem writer.
pub(super) fn merge_remote(root: &Path) -> AppResult<MergeOutcome> {
    let repo = open_existing(root)?;
    ensure_clean_state(&repo)?;
    let branch = current_branch(&repo)?;
    let remote_oid = match repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) {
        Ok(oid) => oid,
        Err(error) if error.code() == git2::ErrorCode::NotFound => return Ok(up_to_date()),
        Err(error) => return Err(error.into()),
    };

    // Ref locks fail before checkout if another Git process is updating HEAD.
    // Keep the old ref reachable until all working-tree and index writes succeed.
    let refname = format!("refs/heads/{branch}");
    let mut transaction = repo.transaction()?;
    transaction.lock_ref("HEAD")?;
    transaction.lock_ref(&refname)?;
    if current_branch(&repo)? != branch {
        return Err(AppError::io(
            "the backup branch changed during sync; retry backup",
        ));
    }
    let annotated = repo.find_annotated_commit(remote_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;
    if analysis.is_up_to_date() {
        return Ok(up_to_date());
    }

    let remote_commit = repo.find_commit(remote_oid)?;
    let local_commit = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?),
        Err(error) if error.code() == git2::ErrorCode::UnbornBranch => None,
        Err(error) => return Err(error.into()),
    };
    let old_tree = local_commit
        .as_ref()
        .map(|commit| without_runtime(&repo, &commit.tree()?))
        .transpose()?;
    let sig = signature(&repo)?;
    let (new_oid, tree, kind, conflicted_paths) =
        if analysis.is_unborn() || analysis.is_fast_forward() {
            let remote_tree = remote_commit.tree()?;
            let tree = without_runtime(&repo, &remote_tree)?;
            // A fetched tree may track another device's runtime database. Preserve
            // its history, but make the new local tip exclude that directory.
            let new_oid = if tree.id() == remote_tree.id() {
                remote_oid
            } else {
                repo.commit(
                    None,
                    &sig,
                    &sig,
                    "Exclude device-local runtime files from backup",
                    &tree,
                    &[&remote_commit],
                )?
            };
            (new_oid, tree, MergeKind::FastForward, Vec::new())
        } else {
            let local_commit = local_commit
                .as_ref()
                .ok_or_else(|| AppError::io("the backup branch has no local commit to merge"))?;
            // Compute and resolve the complete merge in memory. No MERGE_* files
            // or conflicted disk index can survive a failure and wedge later syncs.
            let mut index = repo.merge_commits(local_commit, &remote_commit, None)?;
            remove_from_index(&mut index)?;
            let conflicted_paths = resolve_conflicts(&repo, root, &mut index)?;
            let tree = repo.find_tree(index.write_tree_to(&repo)?)?;
            let (kind, message) = if conflicted_paths.is_empty() {
                (MergeKind::Merged, "Merge changes from other devices")
            } else {
                (
                    MergeKind::MergedWithConflicts,
                    "Merge changes from other devices (conflicts to review)",
                )
            };
            let new_oid = repo.commit(
                None,
                &sig,
                &sig,
                message,
                &tree,
                &[local_commit, &remote_commit],
            )?;
            (new_oid, tree, kind, conflicted_paths)
        };

    let mut changed_files = changed_between(&repo, old_tree.as_ref(), &tree)?;
    let existing_additions =
        matching_additions(&repo, root, old_tree.as_ref(), &tree, &changed_files)?;
    let checkout_paths: Vec<_> = changed_files
        .iter()
        .filter(|change| {
            !existing_additions
                .iter()
                .any(|entry| entry.path == change.path.as_bytes())
        })
        .collect();
    if !checkout_paths.is_empty() {
        let mut checkout = CheckoutBuilder::new();
        checkout
            .safe()
            .overwrite_ignored(false)
            .disable_pathspec_match(true);
        // Restrict the checkout to the sanitized tree diff. In particular,
        // removing a previously tracked .reflect entry must never unlink the
        // local SQLite database or durable chat history.
        for change in checkout_paths {
            checkout.path(&change.path);
        }
        repo.checkout_tree(tree.as_object(), Some(&mut checkout))?;
    }
    let mut index = repo.index()?;
    for entry in existing_additions {
        index.add(&entry)?;
    }
    remove_from_index(&mut index)?;
    index.write()?;
    transaction.set_target(
        &refname,
        new_oid,
        Some(&sig),
        "reflect sync: integrate remote changes",
    )?;
    transaction.commit()?;
    stamp_modified_times(root, &mut changed_files);
    Ok(MergeOutcome {
        kind,
        conflicted_paths,
        changed_files,
        skipped_large_files: Vec::new(),
    })
}

/// Libgit2 treats any existing file at an added path as a checkout conflict,
/// even when its bytes already match. Admit those additions without rewriting
/// them: this covers atomically claimed conflict copies and the scaffold's
/// identical .gitignore when adopting an unborn repository.
fn matching_additions(
    repo: &Repository,
    root: &Path,
    old: Option<&git2::Tree>,
    target: &git2::Tree,
    changes: &[ChangedFile],
) -> AppResult<Vec<IndexEntry>> {
    let current_index = repo.index()?;
    let mut target_index = Index::new()?;
    target_index.read_tree(target)?;
    let mut matches = Vec::new();
    for change in changes {
        if !matches!(change.kind, ChangeKind::Upsert) {
            continue;
        }
        let path = Path::new(&change.path);
        if let Some(old) = old {
            match old.get_path(path) {
                Ok(_) => continue,
                Err(error) if error.code() == git2::ErrorCode::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        let Some(entry) = target_index.get_path(path, 0) else {
            continue;
        };
        if entry.mode != 0o100644 {
            continue;
        }
        if current_index
            .get_path(path, 0)
            .is_some_and(|staged| staged.id != entry.id || staged.mode != entry.mode)
        {
            continue;
        }
        let target = root.join(path);
        let metadata = match target.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 != 0 {
                continue;
            }
        }
        if metadata.file_type().is_file() && repo.blob_path(&target)? == entry.id {
            matches.push(entry);
        }
    }
    Ok(matches)
}

fn up_to_date() -> MergeOutcome {
    MergeOutcome {
        kind: MergeKind::UpToDate,
        conflicted_paths: Vec::new(),
        changed_files: Vec::new(),
        skipped_large_files: Vec::new(),
    }
}

/// Diff two trees into the watcher's change shape: what the merge wrote or
/// removed on disk relative to the previous local HEAD.
fn changed_between(
    repo: &Repository,
    old: Option<&git2::Tree>,
    new: &git2::Tree,
) -> AppResult<Vec<ChangedFile>> {
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    let mut out = Vec::new();
    for delta in diff.deltas() {
        let removed = delta.status() == git2::Delta::Deleted;
        let file = if removed {
            delta.old_file()
        } else {
            delta.new_file()
        };
        if let Some(path) = file.path() {
            out.push(ChangedFile {
                path: path
                    .to_str()
                    .ok_or_else(|| AppError::io("backup contains a non-UTF-8 file path"))?
                    .to_owned(),
                kind: if removed {
                    ChangeKind::Remove
                } else {
                    ChangeKind::Upsert
                },
                modified_ms: None, // stamped once the working tree is final
            });
        }
    }
    Ok(out)
}

/// Fill `modified_ms` for upserts from the (now final) working-tree files.
fn stamp_modified_times(root: &Path, changes: &mut [ChangedFile]) {
    for change in changes {
        if matches!(change.kind, ChangeKind::Remove) {
            continue;
        }
        change.modified_ms = root
            .join(&change.path)
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as u64);
    }
}

/// Resolve conflicted blobs in the in-memory index. Only binary conflict
/// copies are materialized here, using an atomic no-clobber claim. A failed
/// later checkout may leave that copy untracked; retaining it is intentional.
fn resolve_conflicts(repo: &Repository, root: &Path, index: &mut Index) -> AppResult<Vec<String>> {
    let conflicts = index.conflicts()?.collect::<Result<Vec<_>, _>>()?;
    let mut conflicted_paths = Vec::new();
    for conflict in conflicts {
        let paths = [&conflict.ancestor, &conflict.our, &conflict.their]
            .into_iter()
            .flatten()
            .map(entry_path)
            .collect::<AppResult<std::collections::BTreeSet<_>>>()?;
        for path in paths {
            index.conflict_remove(Path::new(path))?;
        }
        match (conflict.our, conflict.their) {
            (Some(our), Some(their)) => {
                conflicted_paths.extend(resolve_both_edited(
                    repo,
                    root,
                    index,
                    conflict.ancestor,
                    our,
                    their,
                )?);
            }
            (Some(edited), None) | (None, Some(edited)) => {
                conflicted_paths.push(entry_path(&edited)?.to_owned());
                add_resolved(index, edited)?;
            }
            (None, None) => {}
        }
    }
    Ok(conflicted_paths)
}

fn entry_path(entry: &IndexEntry) -> AppResult<&str> {
    std::str::from_utf8(&entry.path)
        .map_err(|_| AppError::io("backup contains a conflict with a non-UTF-8 path"))
}

fn add_resolved(index: &mut Index, mut entry: IndexEntry) -> AppResult<()> {
    // Entries obtained from conflicts carry stage 1/2/3 bits. Resolved blobs
    // must be written at stage zero, independent of their original side.
    entry.flags &= !0x3000;
    index.add(&entry)?;
    Ok(())
}

fn resolve_both_edited(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    ancestor: Option<IndexEntry>,
    mut our: IndexEntry,
    mut their: IndexEntry,
) -> AppResult<Vec<String>> {
    let our_path = entry_path(&our)?.to_owned();
    let their_path = entry_path(&their)?.to_owned();
    let our_blob = repo.find_blob(our.id)?;
    let their_blob = repo.find_blob(their.id)?;
    if our_path != their_path {
        add_resolved(index, our)?;
        add_resolved(index, their)?;
        return Ok(vec![our_path, their_path]);
    }
    let binary = our_blob.is_binary()
        || their_blob.is_binary()
        || our.mode & 0o170000 != 0o100000
        || their.mode & 0o170000 != 0o100000;
    if binary {
        let copy = claim_conflict_copy(root, index, &their_path, their_blob.content())?;
        their.path = copy.as_bytes().to_vec();
        // A symlink's raw target is preserved as a regular conflict attachment.
        their.mode = 0o100644;
        add_resolved(index, our)?;
        add_resolved(index, their)?;
        return Ok(vec![our_path, copy]);
    }
    let ancestor_blob = ancestor
        .as_ref()
        .map(|entry| repo.find_blob(entry.id))
        .transpose()?;
    let mut base = MergeFileInput::new();
    base.content(
        ancestor_blob
            .as_ref()
            .map(|blob| blob.content())
            .unwrap_or(&[]),
    );
    let mut ours = MergeFileInput::new();
    ours.path(our_path.as_str()).content(our_blob.content());
    let mut theirs = MergeFileInput::new();
    theirs
        .path(their_path.as_str())
        .content(their_blob.content());
    let mut options = MergeFileOptions::new();
    options
        .our_label(OUR_LABEL)
        .their_label(THEIR_LABEL)
        .style_standard(true);
    let merged = git2::merge_file(&base, &ours, &theirs, Some(&mut options))?;
    our.id = repo.blob(merged.content())?;
    our.file_size = u32::try_from(merged.content().len())
        .map_err(|_| AppError::io("merged note exceeds the Git index size limit"))?;
    add_resolved(index, our)?;
    Ok(vec![our_path])
}

fn claim_conflict_copy(root: &Path, index: &Index, rel: &str, content: &[u8]) -> AppResult<String> {
    let parent = Path::new(rel).parent().unwrap_or(Path::new(""));
    if parent.components().any(|component| {
        !matches!(component, std::path::Component::Normal(_))
            || component.as_os_str().eq_ignore_ascii_case(".git")
    }) || is_runtime_path(Path::new(rel))
    {
        return Err(AppError::io(
            "backup conflict has an unsafe attachment path",
        ));
    }
    let parent = root.join(parent);
    let existing = parent
        .ancestors()
        .find(|ancestor| ancestor.exists())
        .ok_or_else(|| AppError::io("backup conflict attachment directory is unavailable"))?;
    if !existing.canonicalize()?.starts_with(root.canonicalize()?) {
        return Err(AppError::io(
            "backup conflict attachment directory is outside the graph",
        ));
    }
    fs::create_dir_all(&parent)?;
    let mut pending = tempfile::NamedTempFile::new_in(parent)?;
    pending.write_all(content)?;
    pending.as_file().sync_all()?;
    for number in 1.. {
        let copy = conflict_copy_path(rel, number);
        let directory_prefix = format!("{copy}/");
        if index.iter().any(|entry| {
            entry.path.eq_ignore_ascii_case(copy.as_bytes())
                || entry
                    .path
                    .get(..directory_prefix.len())
                    .is_some_and(|prefix| prefix.eq_ignore_ascii_case(directory_prefix.as_bytes()))
        }) {
            continue;
        }
        match pending.persist_noclobber(root.join(&copy)) {
            Ok(_) => return Ok(copy),
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                pending = error.file;
            }
            Err(error) => return Err(error.error.into()),
        }
    }
    unreachable!("the conflict copy counter cannot exhaust")
}

/// `assets/img.png` → `assets/img (conflict).png`; no extension → appended.
/// Splits on the basename only — a dot in a *directory* name (`assets.v1/x`)
/// must not relocate the copy out of the file's directory.
fn conflict_copy_path(rel: &str, number: usize) -> String {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((dir, file)) => (Some(dir), file),
        None => (None, rel),
    };
    let suffix = if number == 1 {
        "conflict".to_owned()
    } else {
        format!("conflict {number}")
    };
    let renamed = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({suffix}).{ext}"),
        _ => format!("{file} ({suffix})"),
    };
    match dir {
        Some(dir) => format!("{dir}/{renamed}"),
        None => renamed,
    }
}

#[cfg(test)]
mod path_tests {
    use super::conflict_copy_path;

    #[test]
    fn conflict_copies_stay_in_their_directory() {
        assert_eq!(
            conflict_copy_path("assets/img.png", 1),
            "assets/img (conflict).png"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img", 1),
            "assets.v1/img (conflict)"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img.png", 1),
            "assets.v1/img (conflict).png"
        );
        assert_eq!(
            conflict_copy_path("topfile.bin", 1),
            "topfile (conflict).bin"
        );
        assert_eq!(conflict_copy_path("noext", 1), "noext (conflict)");
        assert_eq!(
            conflict_copy_path("assets/.hidden", 1),
            "assets/.hidden (conflict)"
        );
    }

    #[test]
    fn concurrent_binary_copy_claims_never_replace_another_copy() {
        let directory = tempfile::tempdir().unwrap();
        let existing = directory.path().join("image (conflict).bin");
        std::fs::write(&existing, b"existing attachment").unwrap();
        let ready = std::sync::Barrier::new(6);
        std::thread::scope(|scope| {
            let handles: Vec<_> = (0..6)
                .map(|number| {
                    let directory = directory.path();
                    let ready = &ready;
                    scope.spawn(move || {
                        let index = git2::Index::new().unwrap();
                        let content = format!("remote attachment {number}");
                        ready.wait();
                        let copy = super::claim_conflict_copy(
                            directory,
                            &index,
                            "image.bin",
                            content.as_bytes(),
                        )
                        .unwrap();
                        assert_eq!(
                            std::fs::read_to_string(directory.join(&copy)).unwrap(),
                            content
                        );
                        copy
                    })
                })
                .collect();
            let paths: std::collections::HashSet<_> = handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .collect();
            assert_eq!(paths.len(), 6);
        });
        assert_eq!(std::fs::read(existing).unwrap(), b"existing attachment");
    }
}
