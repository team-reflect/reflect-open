//! Pull-side merge: fast-forward when possible, otherwise merge — and when
//! the merge conflicts, materialize the conflict **into the note** (standard
//! Git markers with readable labels), commit the merge anyway, and let the
//! user resolve by editing the file.
//!
//! A completed conflict is committed so sync keeps flowing for every other
//! note, both devices converge on the same marked-up file, and the raw versions
//! stay recoverable from the merge commit's two parents. If the process stops
//! first, a private marker under `.git` lets the next sync resume only that
//! verified app-owned merge. The indexer detects content markers and flags the
//! note `Needs review`.
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
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, MergeOptions, Oid, Repository};
use serde::{Deserialize, Serialize};

use crate::error::AppResult;

#[cfg(test)]
use super::repo::open_existing;
use super::repo::{current_branch, ensure_clean_state, open_for_sync, signature};

/// Conflict-marker labels. "this device" is the local side, "other device"
/// the remote one — product language, not branch names.
const OUR_LABEL: &str = "this device";
const THEIR_LABEL: &str = "other device";

/// Written before libgit2 enters merge state and removed after durable
/// completion. If the process is interrupted, the marker plus HEAD,
/// MERGE_HEAD, and ORIG_HEAD let the next sync prove the merge belongs to
/// Reflect and resume it in place. Foreign CLI operations remain hands-off.
const MERGE_RECOVERY_FILE: &str = "REFLECT_MERGE_STATE";

/// Durable identity for one non-fast-forward merge initiated by Reflect.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeRecovery {
    version: u32,
    local_oid: String,
    remote_oid: String,
}

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
}

/// One side of an index conflict, lifted out of the index so the borrow ends
/// before we mutate it.
struct ConflictSide {
    path: String,
    id: git2::Oid,
}

fn side_of(entry: Option<IndexEntry>) -> Option<ConflictSide> {
    entry.map(|entry| ConflictSide {
        path: String::from_utf8_lossy(&entry.path).into_owned(),
        id: entry.id,
    })
}

/// Merge the fetched `origin/<branch>` into the local branch. Pre-condition
/// (the sync engine guarantees it): local changes are already committed.
pub(super) fn merge_remote(root: &Path) -> AppResult<MergeOutcome> {
    let repo = open_for_sync(root)?;
    ensure_clean_state(&repo)?;
    let branch = current_branch(&repo)?;
    let Ok(remote_oid) = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) else {
        // A brand-new (empty) backup repo has no remote branch until the
        // first push creates it. Nothing to merge is success, not an error —
        // the launch cycle (commit → fetch → merge → push) must fall through
        // to that push.
        return Ok(MergeOutcome {
            kind: MergeKind::UpToDate,
            conflicted_paths: Vec::new(),
            changed_files: Vec::new(),
        });
    };
    let annotated = repo.find_annotated_commit(remote_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome {
            kind: MergeKind::UpToDate,
            conflicted_paths: Vec::new(),
            changed_files: Vec::new(),
        });
    }

    if analysis.is_unborn() || analysis.is_fast_forward() {
        // Capture the outgoing tree before the ref moves (None on unborn).
        let old_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let new_tree = repo.find_commit(remote_oid)?.tree()?;
        let mut changed_files = changed_between(&repo, old_tree.as_ref(), &new_tree)?;
        let refname = format!("refs/heads/{branch}");
        repo.reference(&refname, remote_oid, true, "reflect sync: fast-forward")?;
        repo.set_head(&refname)?;
        // Force is safe here: the pre-merge invariant is a committed working
        // tree, so there is nothing uncommitted to clobber.
        repo.checkout_head(Some(CheckoutBuilder::new().force()))?;
        // Stamp mtimes only now — the checkout above is what wrote the files.
        stamp_modified_times(root, &mut changed_files);
        return Ok(MergeOutcome {
            kind: MergeKind::FastForward,
            conflicted_paths: Vec::new(),
            changed_files,
        });
    }

    let local_oid = repo.head()?.peel_to_commit()?.id();
    begin_owned_merge(&repo, local_oid, remote_oid, &annotated)?;

    // From here the marker and MERGE_* refs jointly identify an app-owned
    // operation. If the process stops before completion, the next repository
    // open resumes this exact index instead of resetting the working tree.
    let (conflicted_paths, changed_files) = complete_merge(&repo, root, remote_oid)?;
    remove_recovery_marker_best_effort(&repo);

    let kind = if conflicted_paths.is_empty() {
        MergeKind::Merged
    } else {
        MergeKind::MergedWithConflicts
    };
    Ok(MergeOutcome {
        kind,
        conflicted_paths,
        changed_files,
    })
}

/// Enter libgit2 merge state and write its index and labeled checkout.
fn begin_merge(repo: &Repository, annotated: &git2::AnnotatedCommit<'_>) -> AppResult<()> {
    let mut merge_opts = MergeOptions::new();
    let mut checkout = CheckoutBuilder::new();
    checkout
        .allow_conflicts(true)
        .conflict_style_merge(true)
        .our_label(OUR_LABEL)
        .their_label(THEIR_LABEL);
    repo.merge(&[annotated], Some(&mut merge_opts), Some(&mut checkout))?;
    Ok(())
}

/// Write the recovery marker and enter libgit2 merge state as one owned
/// operation. A merge rejected before it starts drops the marker without
/// touching the user's working tree.
fn begin_owned_merge(
    repo: &Repository,
    local_oid: Oid,
    remote_oid: Oid,
    annotated: &git2::AnnotatedCommit<'_>,
) -> AppResult<()> {
    write_recovery_marker(repo, local_oid, remote_oid)?;
    if let Err(error) = begin_merge(repo, annotated) {
        remove_recovery_marker_best_effort(repo);
        return Err(error);
    }
    Ok(())
}

/// Resume an app-owned merge before any sync primitive reaches its clean-state
/// guard. The marker alone is never authority: HEAD, MERGE_HEAD, and ORIG_HEAD
/// must all match the recorded commits. Any mismatch is treated as a foreign
/// operation and left untouched.
pub(super) fn recover_interrupted_merge(repo: &Repository) -> AppResult<()> {
    let Some(recovery) = read_recovery_marker(repo) else {
        return Ok(());
    };
    let Some((local_oid, remote_oid)) = recovery_oids(repo, &recovery) else {
        return Ok(());
    };
    let Ok(head_oid) = repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map(|commit| commit.id())
    else {
        remove_recovery_marker_best_effort(repo);
        return Ok(());
    };

    // A clean repository cannot still own an interrupted merge. HEAD may be
    // the merge commit itself or any later descendant; either way the marker
    // is stale metadata and must never block another cycle.
    if repo.state() == git2::RepositoryState::Clean {
        remove_recovery_marker_best_effort(repo);
        return Ok(());
    }

    let merge_head = pseudoref_oid(repo, "MERGE_HEAD");
    let orig_head = pseudoref_oid(repo, "ORIG_HEAD");
    let refs_match = merge_head == Some(remote_oid) && orig_head == Some(local_oid);

    if merge_commit_has_parents(repo, head_oid, local_oid, remote_oid)? {
        if repo.state() == git2::RepositoryState::Merge && refs_match {
            // The merge commit landed and only cleanup was interrupted.
            remove_owned_index_lock(repo)?;
            repo.cleanup_state()?;
        }
        // A different active operation is foreign. Forget our stale marker,
        // but leave its state and lock exactly as they are.
        remove_recovery_marker_best_effort(repo);
        return Ok(());
    }

    if repo.state() != git2::RepositoryState::Merge || head_oid != local_oid || !refs_match {
        remove_recovery_marker_best_effort(repo);
        return Ok(());
    }

    // `repo.merge` already wrote the merge index and checkout before the app
    // was interrupted. Continue from that index: untouched working-tree edits
    // stay unstaged, and edits to a text conflict become its chosen resolution.
    remove_owned_index_lock(repo)?;
    let root = repo.workdir().ok_or_else(|| {
        crate::error::AppError::io("the backup repository has no working directory")
    })?;
    complete_merge(repo, root, remote_oid)?;
    remove_recovery_marker_best_effort(repo);
    Ok(())
}

/// Persist the two parents before libgit2 can leave recoverable merge state.
fn write_recovery_marker(repo: &Repository, local_oid: Oid, remote_oid: Oid) -> AppResult<()> {
    let marker = MergeRecovery {
        version: 1,
        local_oid: local_oid.to_string(),
        remote_oid: remote_oid.to_string(),
    };
    let encoded = serde_json::to_string(&marker).map_err(|error| {
        crate::error::AppError::io(format!("failed to encode merge recovery marker: {error}"))
    })?;
    crate::capture::atomic_write_to(&repo.path().join(MERGE_RECOVERY_FILE), &encoded)
}

/// Read a marker without letting malformed metadata wedge the repository.
/// Invalid markers are forgotten; a real foreign Git operation remains for
/// the ordinary clean-state guard to report.
fn read_recovery_marker(repo: &Repository) -> Option<MergeRecovery> {
    let path = repo.path().join(MERGE_RECOVERY_FILE);
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => {
            tracing::warn!(%error, "failed to read merge recovery marker");
            return None;
        }
    };
    let marker: MergeRecovery = match serde_json::from_slice(&bytes) {
        Ok(marker) => marker,
        Err(error) => {
            tracing::warn!(%error, "discarding invalid merge recovery marker");
            remove_recovery_marker_best_effort(repo);
            return None;
        }
    };
    if marker.version != 1 {
        tracing::warn!(
            version = marker.version,
            "discarding unsupported merge recovery marker"
        );
        remove_recovery_marker_best_effort(repo);
        return None;
    }
    Some(marker)
}

/// Parse the marker's commits, discarding metadata that cannot safely identify
/// an operation. Repository state is deliberately not cleaned here.
fn recovery_oids(repo: &Repository, recovery: &MergeRecovery) -> Option<(Oid, Oid)> {
    match (
        Oid::from_str(&recovery.local_oid),
        Oid::from_str(&recovery.remote_oid),
    ) {
        (Ok(local), Ok(remote)) => Some((local, remote)),
        _ => {
            tracing::warn!("discarding merge recovery marker with invalid commits");
            remove_recovery_marker_best_effort(repo);
            None
        }
    }
}

/// Resolve a pseudoref such as MERGE_HEAD without accepting symbolic or
/// multi-line content.
fn pseudoref_oid(repo: &Repository, name: &str) -> Option<Oid> {
    let value = fs::read_to_string(repo.path().join(name)).ok()?;
    let value = value.trim();
    if value.lines().count() != 1 {
        return None;
    }
    Oid::from_str(value).ok()
}

/// Whether HEAD is the durable two-parent commit recorded by the marker.
fn merge_commit_has_parents(
    repo: &Repository,
    head_oid: Oid,
    local_oid: Oid,
    remote_oid: Oid,
) -> AppResult<bool> {
    let commit = repo.find_commit(head_oid)?;
    Ok(commit.parent_count() == 2
        && commit.parent_ids().any(|oid| oid == local_oid)
        && commit.parent_ids().any(|oid| oid == remote_oid))
}

/// Remove the index lock only after the marker and all three merge refs prove
/// this exact operation belongs to Reflect.
fn remove_owned_index_lock(repo: &Repository) -> AppResult<()> {
    let path = repo.path().join("index.lock");
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Marker cleanup is advisory once the repository state or merge commit is
/// durable. Failure is logged and ignored; a stale marker is self-healed on a
/// later clean open and must never turn a successful merge into an error.
fn remove_recovery_marker_best_effort(repo: &Repository) {
    let path = repo.path().join(MERGE_RECOVERY_FILE);
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => tracing::warn!(%error, "failed to remove merge recovery marker"),
    }
}

#[cfg(test)]
/// Enter the same app-owned merge path as production, stopping immediately
/// after libgit2 writes its merge index and checkout to simulate termination.
pub(super) fn interrupt_next_merge_for_test(root: &Path) -> AppResult<()> {
    let repo = open_existing(root)?;
    ensure_clean_state(&repo)?;
    let branch = current_branch(&repo)?;
    let remote_oid = repo.refname_to_id(&format!("refs/remotes/origin/{branch}"))?;
    let local_oid = repo.head()?.peel_to_commit()?.id();
    let annotated = repo.find_annotated_commit(remote_oid)?;
    begin_owned_merge(&repo, local_oid, remote_oid, &annotated)
}

#[cfg(test)]
/// Finish an interrupted app merge but intentionally leave its marker behind,
/// simulating termination between durable completion and marker cleanup.
pub(super) fn finish_interrupted_merge_for_test(root: &Path) -> AppResult<()> {
    let repo = open_existing(root)?;
    let recovery = read_recovery_marker(&repo)
        .ok_or_else(|| crate::error::AppError::io("missing test recovery marker"))?;
    let (_, remote_oid) = recovery_oids(&repo, &recovery)
        .ok_or_else(|| crate::error::AppError::io("invalid test recovery marker"))?;
    complete_merge(&repo, root, remote_oid)?;
    Ok(())
}

/// The post-`repo.merge` half: materialize conflicts, commit with both parents,
/// and clear the merge state. Shared by the normal and recovery paths. An error
/// leaves the verified marker and merge state available for a later retry;
/// successful completion makes the commit durable before cleanup. Returns the
/// conflicted paths and every file the merge changed relative to local HEAD.
fn complete_merge(
    repo: &Repository,
    root: &Path,
    remote_oid: git2::Oid,
) -> AppResult<(Vec<String>, Vec<ChangedFile>)> {
    let mut index = repo.index()?;
    let conflicted_paths = resolve_conflicts(repo, root, &mut index)?;
    index.write()?;

    let tree = repo.find_tree(index.write_tree()?)?;
    let local_commit = repo.head()?.peel_to_commit()?;
    let remote_commit = repo.find_commit(remote_oid)?;
    // The merge tree is final here. Working-tree files may still carry
    // post-interruption edits; their current mtimes remain the correct reindex hints.
    let mut changed_files = changed_between(repo, Some(&local_commit.tree()?), &tree)?;
    stamp_modified_times(root, &mut changed_files);
    let sig = signature(repo)?;
    let message = if conflicted_paths.is_empty() {
        "Merge changes from other devices"
    } else {
        "Merge changes from other devices (conflicts to review)"
    };
    repo.commit(
        Some("HEAD"),
        &sig,
        &sig,
        message,
        &tree,
        &[&local_commit, &remote_commit],
    )?;
    repo.cleanup_state()?;
    Ok((conflicted_paths, changed_files))
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
                path: path.to_string_lossy().replace('\\', "/"),
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

/// Turn every index conflict into committed working-tree content:
///
/// - **text vs text** — the merge checkout already wrote labeled markers into
///   the file; stage it as-is (the user resolves by editing the note);
/// - **edit vs delete** — keep the edited version, never silently delete;
/// - **binary vs binary** — keep ours in place and the other device's copy
///   alongside (`name (conflict).ext`);
/// - **deleted on both** — confirm the removal.
fn resolve_conflicts(repo: &Repository, root: &Path, index: &mut Index) -> AppResult<Vec<String>> {
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }

    struct OwnedConflict {
        our: Option<ConflictSide>,
        their: Option<ConflictSide>,
        ancestor: Option<ConflictSide>,
    }
    let conflicts: Vec<OwnedConflict> = index
        .conflicts()?
        .filter_map(Result::ok)
        .map(|conflict| OwnedConflict {
            our: side_of(conflict.our),
            their: side_of(conflict.their),
            ancestor: side_of(conflict.ancestor),
        })
        .collect();

    let mut conflicted_paths = Vec::new();
    for conflict in conflicts {
        match (conflict.our, conflict.their) {
            (Some(our), Some(their)) => {
                conflicted_paths.extend(resolve_both_edited(repo, root, index, our, their)?);
            }
            (Some(edited), None) | (None, Some(edited)) => {
                conflicted_paths.push(resolve_edit_vs_delete(repo, root, index, edited)?);
            }
            (None, None) => {
                if let Some(ancestor) = conflict.ancestor {
                    index.remove_path(Path::new(&ancestor.path))?;
                }
            }
        }
    }
    Ok(conflicted_paths)
}

/// Both sides changed the file. Text: the merge checkout already wrote the
/// labeled marker file, so staging the working copy clears the conflict
/// entries. Binary: markers would corrupt the bytes — keep ours in place and
/// write the other device's version alongside (`name (conflict).ext`).
fn resolve_both_edited(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    our: ConflictSide,
    their: ConflictSide,
) -> AppResult<Vec<String>> {
    let binary = repo.find_blob(our.id)?.is_binary() || repo.find_blob(their.id)?.is_binary();
    if !binary {
        index.add_path(Path::new(&our.path))?;
        return Ok(vec![our.path]);
    }
    write_blob(repo, root, &our.path, our.id)?;
    let copy = conflict_copy_path(&their.path);
    write_blob(repo, root, &copy, their.id)?;
    index.add_path(Path::new(&our.path))?;
    index.add_path(Path::new(&copy))?;
    Ok(vec![our.path, copy])
}

/// One side edited what the other deleted (either direction): restore and
/// stage the edited version — sync must never silently delete a note someone
/// touched. The user removes it again if the deletion was intentional.
fn resolve_edit_vs_delete(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    edited: ConflictSide,
) -> AppResult<String> {
    write_blob(repo, root, &edited.path, edited.id)?;
    index.add_path(Path::new(&edited.path))?;
    Ok(edited.path)
}

fn write_blob(repo: &Repository, root: &Path, rel: &str, id: git2::Oid) -> AppResult<()> {
    let blob = repo.find_blob(id)?;
    let target = root.join(rel);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(target, blob.content())?;
    Ok(())
}

/// `assets/img.png` → `assets/img (conflict).png`; no extension → appended.
/// Splits on the basename only — a dot in a *directory* name (`assets.v1/x`)
/// must not relocate the copy out of the file's directory.
fn conflict_copy_path(rel: &str) -> String {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((dir, file)) => (Some(dir), file),
        None => (None, rel),
    };
    let renamed = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} (conflict).{ext}"),
        _ => format!("{file} (conflict)"),
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
            conflict_copy_path("assets/img.png"),
            "assets/img (conflict).png"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img"),
            "assets.v1/img (conflict)"
        );
        assert_eq!(
            conflict_copy_path("assets.v1/img.png"),
            "assets.v1/img (conflict).png"
        );
        assert_eq!(conflict_copy_path("topfile.bin"), "topfile (conflict).bin");
        assert_eq!(conflict_copy_path("noext"), "noext (conflict)");
        assert_eq!(
            conflict_copy_path("assets/.hidden"),
            "assets/.hidden (conflict)"
        );
    }
}
