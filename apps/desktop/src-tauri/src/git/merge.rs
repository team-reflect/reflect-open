use std::path::Path;

use git2::{Index, IndexEntry, MergeFileOptions, Repository};
use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::repo::{
    current_branch, ensure_clean_state, exclude_runtime, is_runtime, open_existing, signature,
};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// A refused dirty tree has no changed files; the engine can snapshot and retry.
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merged,
    MergedWithConflicts,
    WorktreeChanged,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// The watcher-compatible mutation kind for direct reindexing.
pub enum ChangeKind {
    Upsert,
    Remove,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// A successfully installed graph-relative file, with its actual disk mtime.
pub struct ChangedFile {
    pub path: String,
    pub kind: ChangeKind,
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
/// Successful checkout changes, or a no-write refusal for pending local edits.
pub struct MergeOutcome {
    pub kind: MergeKind,
    pub conflicted_paths: Vec<String>,
    pub changed_files: Vec<ChangedFile>,
}

fn unchanged(kind: MergeKind) -> MergeOutcome {
    MergeOutcome {
        kind,
        conflicted_paths: Vec::new(),
        changed_files: Vec::new(),
    }
}

/// Prepare the entire merge in memory, then install it under the graph gate.
/// A save during fetch is a recoverable refusal, never a checkout precondition
/// supplied by JavaScript. Neither Git operation state nor the live index is
/// modified during merge calculation or conflict resolution.
pub(super) fn merge_remote(root: &Path) -> AppResult<MergeOutcome> {
    let gate = crate::fs::mutation::gate(root)?;
    let _mutation = gate
        .write()
        .map_err(|_| AppError::io("graph mutation gate poisoned"))?;
    let repo = open_existing(root)?;
    ensure_clean_state(&repo)?;
    let branch = current_branch(&repo)?;
    let remote_oid = match repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) {
        Ok(oid) => oid,
        Err(error) if error.code() == git2::ErrorCode::NotFound => {
            return Ok(unchanged(MergeKind::UpToDate))
        }
        Err(error) => return Err(error.into()),
    };
    let remote_commit = repo.find_commit(remote_oid)?;
    let local_commit = match repo.head() {
        Ok(head) => Some(head.peel_to_commit()?),
        Err(error)
            if matches!(
                error.code(),
                git2::ErrorCode::UnbornBranch | git2::ErrorCode::NotFound
            ) =>
        {
            None
        }
        Err(error) => return Err(error.into()),
    };
    let annotated = repo.find_annotated_commit(remote_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;
    if analysis.is_up_to_date() {
        return Ok(unchanged(MergeKind::UpToDate));
    }
    if has_local_changes(&repo, local_commit.is_some())? {
        return Ok(unchanged(MergeKind::WorktreeChanged));
    }

    let old_tree = local_commit
        .as_ref()
        .map(|commit| commit.tree())
        .transpose()?;
    let fast_forward = analysis.is_fast_forward() || analysis.is_unborn();
    let mut index = if fast_forward {
        let mut index = Index::new()?;
        index.read_tree(&remote_commit.tree()?)?;
        index
    } else {
        repo.merge_commits(
            local_commit
                .as_ref()
                .ok_or_else(|| AppError::io("missing local commit"))?,
            &remote_commit,
            None,
        )?
    };
    exclude_runtime(&mut index)?;
    let conflicted_paths = resolve_conflicts(&repo, root, &mut index)?;
    let tree = repo.find_tree(index.write_tree_to(&repo)?)?;
    let sig = signature(&repo)?;
    let target = if fast_forward && tree.id() == remote_commit.tree_id() {
        remote_oid
    } else {
        let mut parents = Vec::new();
        if !fast_forward {
            parents.extend(local_commit.iter());
        }
        parents.push(&remote_commit);
        repo.commit(
            None,
            &sig,
            &sig,
            if fast_forward {
                "Exclude local Reflect runtime from backup"
            } else if conflicted_paths.is_empty() {
                "Merge changes from other devices"
            } else {
                "Merge changes from other devices (conflicts to review)"
            },
            &tree,
            &parents,
        )?
    };
    let mut changed_files = changed_between(&repo, old_tree.as_ref(), &tree)?;
    super::checkout::install(
        &repo,
        root,
        &branch,
        local_commit.as_ref().map(|commit| commit.id()),
        target,
        old_tree.as_ref(),
        &tree,
    )?;
    for change in &mut changed_files {
        if matches!(change.kind, ChangeKind::Upsert) {
            change.modified_ms = std::fs::metadata(root.join(&change.path))
                .ok()
                .and_then(|metadata| crate::fs::modified_ms(&metadata));
        }
    }
    let kind = if !conflicted_paths.is_empty() {
        MergeKind::MergedWithConflicts
    } else if fast_forward && target == remote_oid {
        MergeKind::FastForward
    } else {
        MergeKind::Merged
    };
    Ok(MergeOutcome {
        kind,
        conflicted_paths,
        changed_files,
    })
}

fn has_local_changes(repo: &Repository, include_untracked: bool) -> AppResult<bool> {
    let mut options = git2::StatusOptions::new();
    options
        .include_untracked(include_untracked)
        .recurse_untracked_dirs(true)
        .update_index(false);
    Ok(repo
        .statuses(Some(&mut options))?
        .iter()
        .any(|entry| !is_runtime(entry.path_bytes()) && entry.status() != git2::Status::CURRENT))
}

fn changed_between(
    repo: &Repository,
    old: Option<&git2::Tree>,
    new: &git2::Tree,
) -> AppResult<Vec<ChangedFile>> {
    let diff = repo.diff_tree_to_tree(old, Some(new), None)?;
    let mut changes = Vec::new();
    for delta in diff.deltas() {
        let removed = delta.status() == git2::Delta::Deleted;
        let file = if removed {
            delta.old_file()
        } else {
            delta.new_file()
        };
        if let Some(path) = file.path() {
            let path = path
                .to_str()
                .ok_or_else(|| AppError::io("non-UTF-8 Git path"))?;
            if !is_runtime(path.as_bytes()) {
                changes.push(ChangedFile {
                    path: path.to_owned(),
                    kind: if removed {
                        ChangeKind::Remove
                    } else {
                        ChangeKind::Upsert
                    },
                    modified_ms: None,
                });
            }
        }
    }
    Ok(changes)
}

fn path_of(entry: &IndexEntry) -> AppResult<&str> {
    std::str::from_utf8(&entry.path).map_err(|_| AppError::io("non-UTF-8 conflict path"))
}

fn stage(index: &mut Index, mut entry: IndexEntry, id: git2::Oid) -> AppResult<()> {
    index.remove_path(Path::new(path_of(&entry)?))?;
    entry.id = id;
    entry.flags &= !0x3000;
    index.add(&entry)?;
    Ok(())
}

fn resolve_conflicts(repo: &Repository, root: &Path, index: &mut Index) -> AppResult<Vec<String>> {
    let conflicts = index.conflicts()?.collect::<Result<Vec<_>, _>>()?;
    let mut paths = Vec::new();
    for conflict in conflicts {
        match (conflict.our, conflict.their) {
            (Some(our), Some(their)) => {
                let our_path = path_of(&our)?.to_owned();
                let their_path = path_of(&their)?.to_owned();
                if our_path != their_path {
                    let our_id = our.id;
                    let their_id = their.id;
                    stage(index, our, our_id)?;
                    stage(index, their, their_id)?;
                    paths.extend([our_path, their_path]);
                } else if repo.find_blob(our.id)?.is_binary()
                    || repo.find_blob(their.id)?.is_binary()
                {
                    let copy = available_copy(root, index, &their_path)?;
                    let our_id = our.id;
                    let their_id = their.id;
                    stage(index, our, our_id)?;
                    let mut copy_entry = their;
                    copy_entry.path = copy.as_bytes().to_vec();
                    stage(index, copy_entry, their_id)?;
                    paths.extend([our_path, copy]);
                } else {
                    let ancestor = match conflict.ancestor {
                        Some(ancestor) => ancestor,
                        None => {
                            let mut empty = index
                                .get_path(Path::new(&our_path), 2)
                                .ok_or_else(|| AppError::io("missing conflict entry"))?;
                            empty.id = repo.blob(b"")?;
                            empty
                        }
                    };
                    let mut options = MergeFileOptions::new();
                    options.our_label("this device").their_label("other device");
                    let merged =
                        repo.merge_file_from_index(&ancestor, &our, &their, Some(&mut options))?;
                    let id = repo.blob(merged.content())?;
                    stage(index, our, id)?;
                    paths.push(our_path);
                }
            }
            (Some(edited), None) | (None, Some(edited)) => {
                paths.push(path_of(&edited)?.to_owned());
                let id = edited.id;
                stage(index, edited, id)?;
            }
            (None, None) => {
                if let Some(ancestor) = conflict.ancestor {
                    index.remove_path(Path::new(path_of(&ancestor)?))?;
                }
            }
        }
    }
    Ok(paths)
}

fn available_copy(root: &Path, index: &Index, path: &str) -> AppResult<String> {
    for number in 1..=10_000 {
        let candidate = conflict_copy_path(path, number);
        if !index.iter().any(|entry| entry.path == candidate.as_bytes())
            && std::fs::symlink_metadata(root.join(&candidate))
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(candidate);
        }
    }
    Err(AppError::io("too many conflict copies; no free filename"))
}

fn conflict_copy_path(rel: &str, number: usize) -> String {
    let path = Path::new(rel);
    let file = path.file_name().unwrap_or_default().to_string_lossy();
    let suffix = if number == 1 {
        " (conflict)".to_string()
    } else {
        format!(" (conflict {number})")
    };
    let renamed = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem}{suffix}.{ext}"),
        _ => format!("{file}{suffix}"),
    };
    path.with_file_name(renamed)
        .to_string_lossy()
        .replace('\\', "/")
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
            conflict_copy_path("assets.v1/img", 2),
            "assets.v1/img (conflict 2)"
        );
        assert_eq!(
            conflict_copy_path("assets/.hidden", 1),
            "assets/.hidden (conflict)"
        );
    }
}
