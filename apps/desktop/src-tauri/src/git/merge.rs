//! Pull-side merge: fast-forward when possible, otherwise a true merge.
//!
//! The merge is computed in memory (`merge_commits`), its conflicts are
//! resolved in that index, and the result is committed with both parents.
//! Only then is the merged tree checked out, and the branch ref moves last.
//! The repository never enters libgit2's merge state. Until the ref moves,
//! the merge commit is recorded in `refs/reflect/merge`, so a stop after the
//! commit is finished by [`adopt_recorded_merge`] instead of merged again.
//! A text conflict is resolved by the conflict ladder ([`ladder::resolve`]),
//! so pulls never write conflict markers.

use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, IndexTime, MergeOptions, Repository};
use reflect_graph_paths::to_slash_lossy;
use serde::Serialize;

use crate::conflict::archive::archive_unless_in_history;
use crate::conflict::ladder::{self, ConflictInput};
use crate::conflict::{ConflictSide, Resolution};
use crate::error::{AppError, AppResult};

use super::repo::{current_branch, ensure_clean_state, open_existing, signature};

/// Side labels for the ladder. "this device" is the local side, "other device"
/// the remote one — product language, not branch names.
const OUR_LABEL: &str = "this device";
const THEIR_LABEL: &str = "other device";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merged,
    MergedWithReview,
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
    /// Graph-relative paths the user should review: a binary conflict copy or
    /// an edit kept against a deletion.
    pub review_paths: Vec<String>,
    /// Every file this merge changed on disk. The sync layer reindexes these
    /// directly — pulls must not depend on the file watcher being up (on
    /// launch it may not be yet) to keep the index in step with the notes.
    /// Deletions carry `modified_ms: None`; upserts carry the written file's
    /// real mtime.
    pub changed_files: Vec<ChangedFile>,
}

/// Merge the fetched `origin/<branch>` into the local branch. Local edits not
/// yet committed are kept on disk and stay uncommitted.
pub(super) fn merge_remote(root: &Path) -> AppResult<MergeOutcome> {
    crate::fs::with_graph_lock(root, || merge_remote_locked(root))
}

fn merge_remote_locked(root: &Path) -> AppResult<MergeOutcome> {
    let repo = open_existing(root)?;
    let adopted = adopt_recorded_merge(&repo, root)?;
    let mut outcome = pull(&repo, root)?;
    fold_changes(&mut outcome.changed_files, adopted);
    Ok(outcome)
}

fn pull(repo: &Repository, root: &Path) -> AppResult<MergeOutcome> {
    ensure_clean_state(repo)?;
    let branch = current_branch(repo)?;
    let Ok(remote_oid) = repo.refname_to_id(&format!("refs/remotes/origin/{branch}")) else {
        // A brand-new (empty) backup repo has no remote branch until the
        // first push creates it. Nothing to merge is success, not an error —
        // the launch cycle (commit → fetch → merge → push) must fall through
        // to that push.
        return Ok(MergeOutcome {
            kind: MergeKind::UpToDate,
            review_paths: Vec::new(),
            changed_files: Vec::new(),
        });
    };
    let annotated = repo.find_annotated_commit(remote_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome {
            kind: MergeKind::UpToDate,
            review_paths: Vec::new(),
            changed_files: Vec::new(),
        });
    }

    if analysis.is_unborn() || analysis.is_fast_forward() {
        // Capture the outgoing tree before anything moves (None on unborn).
        let old_oid = repo.head().ok().and_then(|head| head.target());
        let old_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let incoming = repo.find_commit(remote_oid)?;
        let new_tree = incoming.tree()?;
        let mut changed_files = changed_between(repo, old_tree.as_ref(), &new_tree)?;
        // Files first, ref last: a failure in between leaves the branch where
        // it was, so the next cycle retries the pull instead of committing
        // the stale tree as a revert of it (#1405).
        #[cfg(test)]
        super::fault::trip(super::fault::FaultPoint::BeforeFastForwardCheckout)?;
        let (written, review) =
            checkout_keeping_local_edits(repo, root, old_tree.as_ref(), &new_tree, &incoming)?;
        stamp_modified_times(root, &mut changed_files);
        fold_changes(&mut changed_files, written);
        #[cfg(test)]
        super::fault::trip(super::fault::FaultPoint::BeforeFastForwardRefMove)?;
        let refname = format!("refs/heads/{branch}");
        let message = "reflect sync: fast-forward";
        match old_oid {
            // Guarded: the branch must still be where this pull started.
            Some(old_oid) => {
                repo.reference_matching(&refname, remote_oid, true, old_oid, message)?
            }
            None => repo.reference(&refname, remote_oid, true, message)?,
        };
        // HEAD already points at the branch (`current_branch` checked), so no
        // `set_head`: it only added a `HEAD.lock` dependency to every pull.
        return Ok(MergeOutcome {
            kind: MergeKind::FastForward,
            review_paths: review,
            changed_files,
        });
    }

    let ours = repo.head()?.peel_to_commit()?;
    let head_oid = ours.id();
    let theirs = repo.find_commit(remote_oid)?;
    let mut index = repo.merge_commits(&ours, &theirs, Some(&MergeOptions::new()))?;
    let review_paths = resolve_index_conflicts(repo, root, &mut index, &ours, &theirs)?;
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeMergeCommit)?;

    let tree = repo.find_tree(index.write_tree_to(repo)?)?;
    let sig = signature(repo)?;
    let message = if review_paths.is_empty() {
        "Merge changes from other devices"
    } else {
        "Merge changes from other devices (files to review)"
    };
    let merge_oid = repo.commit(None, &sig, &sig, message, &tree, &[&ours, &theirs])?;
    repo.reference(RECORDED_MERGE_REF, merge_oid, true, "merge in progress")?;
    let merge = repo.find_commit(merge_oid)?;
    let ours_tree = ours.tree()?;
    let mut changed_files = changed_between(repo, Some(&ours_tree), &tree)?;

    // Same order as the fast-forward: tree first, ref last. A stop in between
    // leaves the merge recorded for `adopt_recorded_merge`.
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::AfterMergeCommitBeforeCheckout)?;
    let (written, review) =
        checkout_keeping_local_edits(repo, root, Some(&ours_tree), &tree, &merge)?;
    stamp_modified_times(root, &mut changed_files);
    fold_changes(&mut changed_files, written);
    let mut review_paths = review_paths;
    review_paths.extend(review);
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeMergeRefMove)?;
    repo.reference_matching(
        &format!("refs/heads/{branch}"),
        merge_oid,
        true,
        head_oid,
        message,
    )?;
    drop_recorded_merge(repo)?;

    let kind = if review_paths.is_empty() {
        MergeKind::Merged
    } else {
        MergeKind::MergedWithReview
    };
    Ok(MergeOutcome {
        kind,
        review_paths,
        changed_files,
    })
}

/// The merge commit `merge_remote` wrote and has not yet moved the branch to.
const RECORDED_MERGE_REF: &str = "refs/reflect/merge";

/// Finish a merge that stopped between its commit and the branch move.
///
/// When `HEAD` is still the recorded merge's first parent, the merged tree is
/// checked out (edits made since the stop are merged back in) and the branch
/// moves to the merge. Any other recorded merge is dropped. Returns the files
/// the adoption changed on disk.
pub(super) fn adopt_recorded_merge(repo: &Repository, root: &Path) -> AppResult<Vec<ChangedFile>> {
    let Ok(merge_oid) = repo.refname_to_id(RECORDED_MERGE_REF) else {
        return Ok(Vec::new());
    };
    let head_oid = repo.head().ok().and_then(|head| head.target());
    let merge = repo.find_commit(merge_oid)?;
    let mut changed_files = Vec::new();
    match head_oid {
        Some(head_oid) if merge.parent_id(0).ok() == Some(head_oid) => {
            let branch = current_branch(repo)?;
            let head_tree = repo.find_commit(head_oid)?.tree()?;
            let merge_tree = merge.tree()?;
            changed_files = changed_between(repo, Some(&head_tree), &merge_tree)?;
            let (written, _) =
                checkout_keeping_local_edits(repo, root, Some(&head_tree), &merge_tree, &merge)?;
            stamp_modified_times(root, &mut changed_files);
            fold_changes(&mut changed_files, written);
            repo.reference_matching(
                &format!("refs/heads/{branch}"),
                merge_oid,
                true,
                head_oid,
                "reflect sync: adopt recorded merge",
            )?;
        }
        Some(head_oid)
            if head_oid == merge_oid || repo.graph_descendant_of(head_oid, merge_oid)? =>
        {
            tracing::debug!(merge = %merge_oid, "dropping a recorded merge HEAD already contains");
        }
        _ => {
            tracing::warn!(
                root = %root.display(),
                merge = %merge_oid,
                "dropping a recorded merge that does not continue HEAD"
            );
        }
    }
    drop_recorded_merge(repo)?;
    Ok(changed_files)
}

/// One working-tree path whose content differs from `HEAD`; `None` when the
/// file was deleted.
struct LocalEdit {
    path: String,
    bytes: Option<Vec<u8>>,
}

/// What a tree holds at a path.
enum TreeSide<'r> {
    Absent,
    File(git2::Blob<'r>),
    /// A directory, symlink, or submodule.
    Other(git2::Oid),
}

impl TreeSide<'_> {
    fn id(&self) -> Option<git2::Oid> {
        match self {
            TreeSide::Absent => None,
            TreeSide::File(blob) => Some(blob.id()),
            TreeSide::Other(id) => Some(*id),
        }
    }
}

fn tree_side<'r>(
    repo: &'r Repository,
    tree: Option<&git2::Tree<'_>>,
    path: &str,
) -> AppResult<TreeSide<'r>> {
    let Some(entry) = tree.and_then(|tree| tree.get_path(Path::new(path)).ok()) else {
        return Ok(TreeSide::Absent);
    };
    if matches!(entry.filemode(), 0o100644 | 0o100755) {
        Ok(TreeSide::File(repo.find_blob(entry.id())?))
    } else {
        Ok(TreeSide::Other(entry.id()))
    }
}

/// Check out `target` over a working tree whose committed state is `base`,
/// keeping every local edit made since that commit.
///
/// The edits are read before the forced checkout and written back after it:
/// unchanged by `target`, an edit is restored as it was; changed by both, a
/// text file is resolved by the ladder (base, local edit, target), and any
/// other file keeps the local bytes with the target's version written beside
/// it as a conflict copy. `incoming` is the commit `target` belongs to.
/// Returns the files written back and the conflict copies.
fn checkout_keeping_local_edits(
    repo: &Repository,
    root: &Path,
    base: Option<&git2::Tree<'_>>,
    target: &git2::Tree<'_>,
    incoming: &git2::Commit<'_>,
) -> AppResult<(Vec<ChangedFile>, Vec<String>)> {
    let edits = local_edits(repo, root, base)?;
    repo.checkout_tree(target.as_object(), Some(CheckoutBuilder::new().force()))?;

    let mut written = Vec::new();
    let mut review = Vec::new();
    for edit in edits {
        let base_side = tree_side(repo, base, &edit.path)?;
        let target_side = tree_side(repo, Some(target), &edit.path)?;
        let Some(ours) = edit.bytes else {
            if base_side.id() == target_side.id() {
                let target_path = root.join(&edit.path);
                if target_path.symlink_metadata().is_ok() {
                    std::fs::remove_file(&target_path)?;
                    written.push(ChangedFile {
                        path: edit.path,
                        kind: ChangeKind::Remove,
                        modified_ms: None,
                    });
                }
            }
            continue;
        };
        let content = match (&base_side, &target_side) {
            _ if base_side.id() == target_side.id() => ours,
            (_, TreeSide::Absent) => ours,
            (TreeSide::Absent | TreeSide::File(_), TreeSide::File(theirs))
                if is_text_bytes(&ours)
                    && is_text_bytes(theirs.content())
                    && match &base_side {
                        TreeSide::File(blob) => is_text_bytes(blob.content()),
                        _ => true,
                    } =>
            {
                let base_content = match &base_side {
                    TreeSide::File(blob) => Some(blob.content()),
                    _ => None,
                };
                merge_local_edit(
                    root,
                    &edit.path,
                    base_content,
                    &ours,
                    theirs.content(),
                    commit_ms(incoming),
                )?
            }
            (_, TreeSide::File(theirs)) => {
                let copy = conflict_copy_path(&edit.path);
                written.push(write_file(root, &copy, theirs.content())?);
                review.push(copy);
                ours
            }
            (_, TreeSide::Other(_)) => {
                // The target holds a directory, symlink, or submodule here.
                let copy = conflict_copy_path(&edit.path);
                written.push(write_file(root, &copy, &ours)?);
                review.push(copy);
                continue;
            }
        };
        written.push(write_file(root, &edit.path, &content)?);
    }
    Ok((written, review))
}

/// Every regular file in the working tree that differs from `base`, including
/// untracked files and deletions. Ignored files are left out.
fn local_edits(
    repo: &Repository,
    root: &Path,
    base: Option<&git2::Tree<'_>>,
) -> AppResult<Vec<LocalEdit>> {
    let mut opts = git2::DiffOptions::new();
    opts.include_untracked(true).recurse_untracked_dirs(true);
    let diff = repo.diff_tree_to_workdir(base, Some(&mut opts))?;
    let mut edits = Vec::new();
    for delta in diff.deltas() {
        let deleted = delta.status() == git2::Delta::Deleted;
        let file = if deleted {
            delta.old_file()
        } else {
            delta.new_file()
        };
        let Some(path) = file.path() else {
            continue;
        };
        let rel = to_slash_lossy(path);
        if deleted {
            edits.push(LocalEdit {
                path: rel,
                bytes: None,
            });
            continue;
        }
        let full = root.join(path);
        let is_file = full
            .symlink_metadata()
            .map(|meta| meta.is_file())
            .unwrap_or(false);
        if is_file {
            edits.push(LocalEdit {
                path: rel,
                bytes: Some(std::fs::read(&full)?),
            });
        }
    }
    Ok(edits)
}

/// Resolve a local edit against an incoming text version through the ladder.
/// The disk side is not in history, so a lossy result archives it first.
fn merge_local_edit(
    root: &Path,
    rel: &str,
    base: Option<&[u8]>,
    ours: &[u8],
    theirs: &[u8],
    incoming_ms: u64,
) -> AppResult<Vec<u8>> {
    let ours_side = text_side(ours, OUR_LABEL, now_ms())?;
    let theirs_side = text_side(theirs, THEIR_LABEL, incoming_ms)?;
    let base = base.map(text_of).transpose()?;
    let content = match ladder::resolve(ConflictInput {
        base,
        sides: (ours_side.clone(), theirs_side),
        merge_loop_detected: false,
    })? {
        Resolution::AlreadyResolved => return Ok(ours.to_vec()),
        Resolution::Merged { content } => content,
        Resolution::Reconciled { content } => {
            archive_side(root, rel, &ours_side)?;
            content
        }
    };
    Ok(content.into_bytes())
}

/// Resolve a text conflict of the in-memory merge through the ladder. Both
/// sides are commit blobs, so their commit times order them on every device.
fn merge_index_text(
    root: &Path,
    rel: &str,
    base: Option<&[u8]>,
    ours: (&[u8], &git2::Commit<'_>),
    theirs: (&[u8], &git2::Commit<'_>),
) -> AppResult<Vec<u8>> {
    let ours_side = text_side(ours.0, OUR_LABEL, commit_ms(ours.1))?;
    let theirs_side = text_side(theirs.0, THEIR_LABEL, commit_ms(theirs.1))?;
    let base = base.map(text_of).transpose()?;
    let content = match ladder::resolve(ConflictInput {
        base,
        sides: (ours_side.clone(), theirs_side.clone()),
        merge_loop_detected: false,
    })? {
        Resolution::AlreadyResolved => return Ok(ours.0.to_vec()),
        Resolution::Merged { content } => content,
        Resolution::Reconciled { content } => {
            archive_side(root, rel, &ours_side)?;
            archive_side(root, rel, &theirs_side)?;
            content
        }
    };
    Ok(content.into_bytes())
}

fn text_of(bytes: &[u8]) -> AppResult<&str> {
    std::str::from_utf8(bytes).map_err(|_| AppError::io("a text side is not UTF-8"))
}

fn text_side(bytes: &[u8], label: &str, modified_ms: u64) -> AppResult<ConflictSide> {
    Ok(ConflictSide {
        content: text_of(bytes)?.to_string(),
        label: label.to_string(),
        modified_ms,
    })
}

fn archive_side(root: &Path, rel: &str, side: &ConflictSide) -> AppResult<()> {
    archive_unless_in_history(
        root,
        rel,
        Some(&side.label),
        side.modified_ms,
        side.content.as_bytes(),
    )?;
    Ok(())
}

fn commit_ms(commit: &git2::Commit<'_>) -> u64 {
    commit.time().seconds().max(0) as u64 * 1000
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn write_file(root: &Path, rel: &str, bytes: &[u8]) -> AppResult<ChangedFile> {
    let modified_ms = crate::fs::atomic_write_bytes(root, &root.join(rel), bytes)?;
    Ok(ChangedFile {
        path: rel.to_string(),
        kind: ChangeKind::Upsert,
        modified_ms,
    })
}

/// Add `extra` to `changes`; an entry for the same path replaces the old one.
fn fold_changes(changes: &mut Vec<ChangedFile>, extra: Vec<ChangedFile>) {
    for change in extra {
        changes.retain(|existing| existing.path != change.path);
        changes.push(change);
    }
}

fn is_text_bytes(bytes: &[u8]) -> bool {
    !bytes.contains(&0) && std::str::from_utf8(bytes).is_ok()
}

fn drop_recorded_merge(repo: &Repository) -> AppResult<()> {
    if let Ok(mut reference) = repo.find_reference(RECORDED_MERGE_REF) {
        reference.delete()?;
    }
    Ok(())
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
                path: to_slash_lossy(path),
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

/// Resolve every conflict of an in-memory merge index, so its tree can be
/// written:
///
/// - **text vs text**: the ladder's merged text, not reviewed;
/// - **edit vs delete**: keep the edited version, never silently delete;
/// - **binary or symlink**: keep ours at the path and the other device's
///   version alongside (`name (conflict).ext`);
/// - **submodule**: keep ours;
/// - **deleted on both**: confirm the removal.
///
/// Returns the paths the user should review.
fn resolve_index_conflicts(
    repo: &Repository,
    root: &Path,
    index: &mut Index,
    ours: &git2::Commit<'_>,
    theirs: &git2::Commit<'_>,
) -> AppResult<Vec<String>> {
    if !index.has_conflicts() {
        return Ok(Vec::new());
    }
    let conflicts = index
        .conflicts()?
        .map(|conflict| {
            conflict.map(|conflict| OwnedConflict {
                ancestor: conflict.ancestor,
                our: conflict.our,
                their: conflict.their,
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut review = Vec::new();
    for conflict in conflicts {
        let mut paths: Vec<String> = [&conflict.ancestor, &conflict.our, &conflict.their]
            .into_iter()
            .flatten()
            .map(entry_path)
            .collect();
        paths.sort();
        paths.dedup();
        for path in &paths {
            index.conflict_remove(Path::new(path))?;
        }
        match (conflict.our, conflict.their) {
            (Some(our), Some(their)) => {
                let path = entry_path(&our);
                if our.mode == GITLINK_MODE || their.mode == GITLINK_MODE {
                    add_resolved(index, &path, our.id, our.mode, &mut review)?;
                    continue;
                }
                let plain = our.mode != SYMLINK_MODE && their.mode != SYMLINK_MODE;
                let our_blob = repo.find_blob(our.id)?;
                let their_blob = repo.find_blob(their.id)?;
                let ancestor_blob = match &conflict.ancestor {
                    Some(ancestor) if ancestor.mode != GITLINK_MODE => {
                        Some(repo.find_blob(ancestor.id)?)
                    }
                    _ => None,
                };
                if plain
                    && is_text(&our_blob)
                    && is_text(&their_blob)
                    && ancestor_blob.as_ref().is_none_or(is_text)
                {
                    let merged = merge_index_text(
                        root,
                        &path,
                        ancestor_blob.as_ref().map(|blob| blob.content()),
                        (our_blob.content(), ours),
                        (their_blob.content(), theirs),
                    )?;
                    let id = repo.blob(&merged)?;
                    add_resolved_unreviewed(index, &path, id, our.mode, &mut review)?;
                } else {
                    let copy = conflict_copy_path(&entry_path(&their));
                    add_resolved(index, &path, our.id, our.mode, &mut review)?;
                    add_resolved(index, &copy, their.id, their.mode, &mut review)?;
                }
            }
            (Some(edited), None) | (None, Some(edited)) => {
                let path = entry_path(&edited);
                add_resolved(index, &path, edited.id, edited.mode, &mut review)?;
            }
            (None, None) => {}
        }
    }
    if index.has_conflicts() {
        return Err(AppError::io("the merge left unresolved conflicts"));
    }
    Ok(review)
}

const GITLINK_MODE: u32 = 0o160000;
const SYMLINK_MODE: u32 = 0o120000;

/// Stage a resolved entry and record it for review. A file that collides with
/// a directory (a path under it, or a file at one of its parent paths) moves
/// to its conflict copy path, so neither side is dropped from the tree.
fn add_resolved(
    index: &mut Index,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<()> {
    let staged = stage_resolved(index, path, id, mode, review)?;
    review.push(staged);
    Ok(())
}

/// Stage a resolved entry without recording it for review, unless it had to
/// move to its conflict copy path.
fn add_resolved_unreviewed(
    index: &mut Index,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<()> {
    let staged = stage_resolved(index, path, id, mode, review)?;
    if staged != path {
        review.push(staged);
    }
    Ok(())
}

/// Stage `id` at `path`, or at its conflict copy path when `path` is a
/// directory, and return the path used. Parent files that collide are moved
/// to their conflict copy paths and recorded in `review`.
fn stage_resolved(
    index: &mut Index,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<String> {
    let dir_prefix = format!("{path}/");
    let is_dir = index
        .iter()
        .any(|entry| entry.path.starts_with(dir_prefix.as_bytes()));
    let path = if is_dir {
        conflict_copy_path(path)
    } else {
        path.to_string()
    };
    let mut parent = path.as_str();
    while let Some((dir, _)) = parent.rsplit_once('/') {
        if let Some(file) = index.get_path(Path::new(dir), 0) {
            let copy = conflict_copy_path(dir);
            index.remove_path(Path::new(dir))?;
            index.add(&stage0_entry(&copy, file.id, file.mode))?;
            review.push(copy);
        }
        parent = dir;
    }
    index.add(&stage0_entry(&path, id, mode))?;
    Ok(path)
}

/// One conflict lifted out of the index, so the borrow ends before the index
/// is changed.
struct OwnedConflict {
    ancestor: Option<IndexEntry>,
    our: Option<IndexEntry>,
    their: Option<IndexEntry>,
}

fn entry_path(entry: &IndexEntry) -> String {
    String::from_utf8_lossy(&entry.path).into_owned()
}

fn is_text(blob: &git2::Blob<'_>) -> bool {
    !blob.is_binary() && std::str::from_utf8(blob.content()).is_ok()
}

/// A stage-0 index entry for `path` with zeroed stat data.
fn stage0_entry(path: &str, id: git2::Oid, mode: u32) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id,
        flags: path.len().min(0x0FFF) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
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
