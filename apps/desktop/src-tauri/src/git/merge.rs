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
//! A local deletion of a file the incoming side changed keeps the incoming
//! version (an edit wins over a delete) and reports the path for review.

use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, IndexTime, MergeOptions, Repository};
use reflect_graph_paths::to_slash_lossy;
use serde::{Deserialize, Serialize};

use crate::conflict::archive::{self, archive_unless_in_history};
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
    // In-memory guarantee: the runtime directory never enters the merge.
    repo.add_ignore_rule("/.reflect/")?;
    let recovered = recover_interrupted_pull(&repo, root)?;
    let mut outcome = pull(&repo, root)?;
    fold_changes(&mut outcome.changed_files, recovered.changed_files);
    outcome.review_paths.extend(recovered.review_paths);
    if !outcome.review_paths.is_empty() && matches!(outcome.kind, MergeKind::Merged) {
        outcome.kind = MergeKind::MergedWithReview;
    }
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

/// A commit whose tree holds the local edits a checkout is overwriting, kept
/// until they are written back.
const SAVED_EDITS_REF: &str = "refs/reflect/edits";
/// The path, inside the saved-edits tree, of the [`SavedEditsRecord`] JSON.
const SAVED_EDITS_RECORD: &str = ".reflect-edits.json";

/// What the saved-edits tree cannot hold as entries: the deleted paths and
/// the trees the checkout went from and to.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedEditsRecord {
    /// The tree the edits were made against; `None` on an unborn branch.
    base: Option<String>,
    /// The tree the checkout wrote.
    target: String,
    /// The commit time of the incoming side, in epoch ms.
    incoming_ms: u64,
    /// Paths the working tree had deleted.
    deleted: Vec<String>,
}

/// What finishing an interrupted pull changed on disk.
#[derive(Default)]
pub(super) struct Recovered {
    pub(super) changed_files: Vec<ChangedFile>,
    pub(super) review_paths: Vec<String>,
}

/// Finish a pull that stopped part-way: write back the local edits a stopped
/// checkout saved, then adopt a recorded merge.
pub(super) fn recover_interrupted_pull(repo: &Repository, root: &Path) -> AppResult<Recovered> {
    let replayed = replay_saved_edits(repo, root)?;
    let (adopted, review) = adopt_recorded_merge(repo, root)?;
    let mut changed_files = replayed.written;
    fold_changes(&mut changed_files, adopted);
    let mut review_paths = replayed.review;
    review_paths.extend(review);
    Ok(Recovered {
        changed_files,
        review_paths,
    })
}

/// Finish a merge that stopped between its commit and the branch move.
///
/// When `HEAD` is still the recorded merge's first parent, the merged tree is
/// checked out (edits made since the stop are merged back in) and the branch
/// moves to the merge. Any other recorded merge is dropped. Returns the files
/// the adoption changed on disk and the paths to review.
fn adopt_recorded_merge(
    repo: &Repository,
    root: &Path,
) -> AppResult<(Vec<ChangedFile>, Vec<String>)> {
    let Ok(merge_oid) = repo.refname_to_id(RECORDED_MERGE_REF) else {
        return Ok((Vec::new(), Vec::new()));
    };
    let head_oid = repo.head().ok().and_then(|head| head.target());
    let merge = repo.find_commit(merge_oid)?;
    let mut changed_files = Vec::new();
    let mut review = Vec::new();
    match head_oid {
        Some(head_oid) if merge.parent_id(0).ok() == Some(head_oid) => {
            let branch = current_branch(repo)?;
            let head_tree = repo.find_commit(head_oid)?.tree()?;
            let merge_tree = merge.tree()?;
            changed_files = changed_between(repo, Some(&head_tree), &merge_tree)?;
            let written;
            (written, review) =
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
    Ok((changed_files, review))
}

/// One working-tree path whose content differs from `HEAD`.
struct LocalEdit {
    path: String,
    content: LocalContent,
}

/// What the working tree holds at an edited path.
enum LocalContent {
    Deleted,
    File(Vec<u8>),
    /// A symlink, by its target.
    Symlink(std::path::PathBuf),
}

impl LocalContent {
    /// The bytes a blob of this content holds; `None` for a deletion.
    fn bytes(&self) -> Option<&[u8]> {
        match self {
            LocalContent::Deleted => None,
            LocalContent::File(bytes) => Some(bytes),
            LocalContent::Symlink(link) => Some(link.as_os_str().as_encoded_bytes()),
        }
    }
}

/// What a tree holds at a path.
enum TreeSide<'r> {
    Absent,
    File(git2::Blob<'r>),
    /// A symlink; the blob holds its target.
    Symlink(git2::Blob<'r>),
    /// A directory or submodule.
    Other(git2::Oid),
}

impl TreeSide<'_> {
    fn id(&self) -> Option<git2::Oid> {
        match self {
            TreeSide::Absent => None,
            TreeSide::File(blob) | TreeSide::Symlink(blob) => Some(blob.id()),
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
    match entry.filemode() {
        0o100644 | 0o100755 => Ok(TreeSide::File(repo.find_blob(entry.id())?)),
        mode if mode == SYMLINK_MODE as i32 => Ok(TreeSide::Symlink(repo.find_blob(entry.id())?)),
        _ => Ok(TreeSide::Other(entry.id())),
    }
}

/// Check out `target` over a working tree whose committed state is `base`,
/// keeping every local edit made since that commit.
///
/// The edits are saved in [`SAVED_EDITS_REF`] before the forced checkout and
/// written back after it: unchanged by `target`, an edit is restored as it
/// was; changed by both, a text file is resolved by the ladder (base, local
/// edit, target), and any other file or symlink keeps the local version with
/// the target's version written beside it as a conflict copy. A local
/// deletion of a path `target` changed keeps the target's version and is
/// reported for review. An untracked file under a directory that `target`
/// replaces with a file moves under the conflict copy name of that directory.
/// An edit that cannot be written back is archived and reported for review.
/// `incoming` is the commit `target` belongs to. Returns the files written
/// back and the paths to review.
fn checkout_keeping_local_edits(
    repo: &Repository,
    root: &Path,
    base: Option<&git2::Tree<'_>>,
    target: &git2::Tree<'_>,
    incoming: &git2::Commit<'_>,
) -> AppResult<(Vec<ChangedFile>, Vec<String>)> {
    let edits = local_edits(repo, root, base, target)?;
    let incoming_ms = commit_ms(incoming);
    save_edits(repo, base, target, incoming_ms, &edits)?;
    // The first matching pathspec wins, so the runtime directory stays as it is.
    let mut checkout = CheckoutBuilder::new();
    checkout.force().path("!.reflect").path("*");
    repo.checkout_tree(target.as_object(), Some(&mut checkout))?;
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::AfterCheckoutBeforeWriteBack)?;

    let mut out = WriteBack::default();
    for edit in edits {
        let result = (|| {
            let base_side = tree_side(repo, base, &edit.path)?;
            let target_side = tree_side(repo, Some(target), &edit.path)?;
            write_back_edit(
                root,
                &edit,
                &base_side,
                &target_side,
                Some(target),
                incoming_ms,
                &mut out,
            )
        })();
        if let Err(error) = result {
            keep_unwritten_edit(root, &edit, &error, &mut out);
        }
    }
    if !out.lost {
        drop_saved_edits(repo)?;
    }
    Ok((out.written, out.review))
}

/// What writing local edits back produced.
#[derive(Default)]
struct WriteBack {
    written: Vec<ChangedFile>,
    review: Vec<String>,
    /// Directory paths `target` replaced with a file, to the conflict copy
    /// directory their untracked files move under.
    relocated: std::collections::HashMap<String, String>,
    /// Whether an edit could be neither written back nor archived.
    lost: bool,
}

/// Write one local edit back over a working tree that holds `target_side` at
/// its path (`target` is the tree that side belongs to).
fn write_back_edit(
    root: &Path,
    edit: &LocalEdit,
    base_side: &TreeSide<'_>,
    target_side: &TreeSide<'_>,
    target: Option<&git2::Tree<'_>>,
    incoming_ms: u64,
    out: &mut WriteBack,
) -> AppResult<()> {
    let unchanged = base_side.id() == target_side.id();
    let taken = |path: &str| worktree_or_tree_has(root, target, path);
    if matches!(base_side, TreeSide::Absent) {
        if let Some(parent) = target.and_then(|tree| replaced_parent(tree, &edit.path)) {
            let dir = out
                .relocated
                .entry(parent.clone())
                .or_insert_with(|| free_conflict_copy_path(&parent, taken))
                .clone();
            let moved = format!("{dir}{}", &edit.path[parent.len()..]);
            match &edit.content {
                LocalContent::Deleted => return Ok(()),
                LocalContent::File(bytes) => out.written.push(write_file(root, &moved, bytes)?),
                LocalContent::Symlink(link) => out.written.push(write_symlink(root, &moved, link)?),
            }
            out.review.push(moved);
            return Ok(());
        }
    }
    let ours = match &edit.content {
        LocalContent::Deleted => {
            let target_path = root.join(&edit.path);
            if unchanged {
                if target_path.symlink_metadata().is_ok() {
                    std::fs::remove_file(&target_path)?;
                    out.written.push(ChangedFile {
                        path: edit.path.clone(),
                        kind: ChangeKind::Remove,
                        modified_ms: None,
                    });
                }
            } else if !matches!(target_side, TreeSide::Absent) {
                out.review.push(edit.path.clone());
            }
            return Ok(());
        }
        LocalContent::Symlink(link) => {
            match target_side {
                _ if unchanged => {}
                TreeSide::Absent => {}
                TreeSide::Symlink(theirs)
                    if theirs.content() == link.as_os_str().as_encoded_bytes() => {}
                TreeSide::Other(_) => {
                    // The target holds a directory or submodule here.
                    let copy = free_conflict_copy_path(&edit.path, taken);
                    out.written.push(write_symlink(root, &copy, link)?);
                    out.review.push(copy);
                    return Ok(());
                }
                TreeSide::File(theirs) | TreeSide::Symlink(theirs) => {
                    let copy = free_conflict_copy_path(&edit.path, taken);
                    out.written
                        .push(write_side(root, &copy, target_side, theirs)?);
                    out.review.push(copy);
                }
            }
            out.written.push(write_symlink(root, &edit.path, link)?);
            return Ok(());
        }
        LocalContent::File(bytes) => bytes,
    };
    let content = match (base_side, target_side) {
        _ if unchanged => ours.clone(),
        (_, TreeSide::Absent) => ours.clone(),
        (TreeSide::Absent | TreeSide::File(_), TreeSide::File(theirs))
            if is_text_bytes(ours)
                && is_text_bytes(theirs.content())
                && match base_side {
                    TreeSide::File(blob) => is_text_bytes(blob.content()),
                    _ => true,
                } =>
        {
            let base_content = match base_side {
                TreeSide::File(blob) => Some(blob.content()),
                _ => None,
            };
            merge_local_edit(
                root,
                &edit.path,
                base_content,
                ours,
                theirs.content(),
                incoming_ms,
            )?
        }
        (_, TreeSide::File(theirs)) => {
            let copy = free_conflict_copy_path(&edit.path, taken);
            out.written.push(write_file(root, &copy, theirs.content())?);
            out.review.push(copy);
            ours.clone()
        }
        (_, TreeSide::Symlink(_) | TreeSide::Other(_)) => {
            // The target holds a directory, symlink, or submodule here.
            let copy = free_conflict_copy_path(&edit.path, taken);
            out.written.push(write_file(root, &copy, ours)?);
            out.review.push(copy);
            return Ok(());
        }
    };
    out.written.push(write_file(root, &edit.path, &content)?);
    Ok(())
}

/// Archive a local edit that could not be written back and report its path.
fn keep_unwritten_edit(root: &Path, edit: &LocalEdit, error: &AppError, out: &mut WriteBack) {
    tracing::warn!(path = %edit.path, ?error, "a local edit could not be written back");
    if let Some(bytes) = edit.content.bytes() {
        if let Err(error) =
            archive::archive_version(root, &edit.path, Some(OUR_LABEL), now_ms(), bytes)
        {
            tracing::error!(path = %edit.path, ?error, "a local edit could not be archived");
            out.lost = true;
        }
    }
    out.review.push(edit.path.clone());
}

/// The closest parent directory of `rel` that `target` holds as something
/// other than a directory.
fn replaced_parent(target: &git2::Tree<'_>, rel: &str) -> Option<String> {
    rel.match_indices('/').find_map(|(end, _)| {
        let parent = &rel[..end];
        let entry = target.get_path(Path::new(parent)).ok()?;
        (entry.kind() != Some(git2::ObjectType::Tree)).then(|| parent.to_string())
    })
}

/// Record `edits` in [`SAVED_EDITS_REF`]: a commit (parent: `HEAD`) whose
/// tree holds each edited file and symlink at its path, plus the
/// [`SavedEditsRecord`] at [`SAVED_EDITS_RECORD`].
fn save_edits(
    repo: &Repository,
    base: Option<&git2::Tree<'_>>,
    target: &git2::Tree<'_>,
    incoming_ms: u64,
    edits: &[LocalEdit],
) -> AppResult<()> {
    if edits.is_empty() {
        return Ok(());
    }
    let mut index = Index::new()?;
    let mut deleted = Vec::new();
    for edit in edits {
        let mode = match edit.content {
            LocalContent::Deleted => {
                deleted.push(edit.path.clone());
                continue;
            }
            LocalContent::File(_) => 0o100644,
            LocalContent::Symlink(_) => SYMLINK_MODE,
        };
        let id = repo.blob(edit.content.bytes().unwrap_or_default())?;
        index.add(&stage0_entry(&edit.path, id, mode))?;
    }
    let record = SavedEditsRecord {
        base: base.map(|tree| tree.id().to_string()),
        target: target.id().to_string(),
        incoming_ms,
        deleted,
    };
    let record = serde_json::to_vec(&record).map_err(|error| AppError::io(error.to_string()))?;
    index.add(&stage0_entry(
        SAVED_EDITS_RECORD,
        repo.blob(&record)?,
        0o100644,
    ))?;
    let tree = repo.find_tree(index.write_tree_to(repo)?)?;
    let sig = signature(repo)?;
    let head = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    let parents: Vec<&git2::Commit<'_>> = head.iter().collect();
    let oid = repo.commit(
        None,
        &sig,
        &sig,
        "reflect sync: local edits held across a checkout",
        &tree,
        &parents,
    )?;
    repo.reference(SAVED_EDITS_REF, oid, true, "save local edits")?;
    Ok(())
}

/// Write back the edits a stopped checkout saved in [`SAVED_EDITS_REF`].
///
/// An edit is written back only where the disk still holds what the checkout
/// started from or wrote, so a later change on disk is never overwritten.
fn replay_saved_edits(repo: &Repository, root: &Path) -> AppResult<WriteBack> {
    let Ok(oid) = repo.refname_to_id(SAVED_EDITS_REF) else {
        return Ok(WriteBack::default());
    };
    let tree = repo.find_commit(oid)?.tree()?;
    let record = tree.get_path(Path::new(SAVED_EDITS_RECORD))?;
    let record: SavedEditsRecord = serde_json::from_slice(repo.find_blob(record.id())?.content())
        .map_err(|error| AppError::io(error.to_string()))?;
    let base = match &record.base {
        Some(id) => Some(repo.find_tree(git2::Oid::from_str(id)?)?),
        None => None,
    };
    let target = repo.find_tree(git2::Oid::from_str(&record.target)?)?;

    let mut edits = Vec::new();
    let mut walk_error = None;
    tree.walk(git2::TreeWalkMode::PreOrder, |dir, entry| {
        let path = format!("{dir}{}", entry.name().unwrap_or_default());
        let mode = entry.filemode() as u32;
        if path == SAVED_EDITS_RECORD || entry.kind() != Some(git2::ObjectType::Blob) {
            return git2::TreeWalkResult::Ok;
        }
        match repo.find_blob(entry.id()) {
            Ok(blob) => {
                let bytes = blob.content().to_vec();
                let content = if mode == SYMLINK_MODE {
                    LocalContent::Symlink(std::path::PathBuf::from(
                        String::from_utf8_lossy(&bytes).as_ref(),
                    ))
                } else {
                    LocalContent::File(bytes)
                };
                edits.push(LocalEdit { path, content });
                git2::TreeWalkResult::Ok
            }
            Err(error) => {
                walk_error = Some(error);
                git2::TreeWalkResult::Abort
            }
        }
    })?;
    if let Some(error) = walk_error {
        return Err(error.into());
    }
    edits.extend(record.deleted.into_iter().map(|path| LocalEdit {
        path,
        content: LocalContent::Deleted,
    }));

    let mut out = WriteBack::default();
    for edit in edits {
        let result = (|| {
            let base_side = tree_side(repo, base.as_ref(), &edit.path)?;
            let target_side = tree_side(repo, Some(&target), &edit.path)?;
            let disk = DiskSide::read(root, &edit.path);
            let (on_disk, tree) = if disk.holds(&target_side) {
                (&target_side, Some(&target))
            } else if disk.holds(&base_side) {
                (&base_side, base.as_ref())
            } else {
                return Ok(());
            };
            write_back_edit(
                root,
                &edit,
                &base_side,
                on_disk,
                tree,
                record.incoming_ms,
                &mut out,
            )
        })();
        if let Err(error) = result {
            keep_unwritten_edit(root, &edit, &error, &mut out);
        }
    }
    if !out.lost {
        drop_saved_edits(repo)?;
    }
    Ok(out)
}

/// What the working tree holds at a path.
enum DiskSide {
    Absent,
    File(Vec<u8>),
    /// A symlink, by its target's bytes.
    Symlink(Vec<u8>),
    Directory,
}

impl DiskSide {
    fn read(root: &Path, rel: &str) -> DiskSide {
        let full = root.join(rel);
        let Ok(meta) = full.symlink_metadata() else {
            return DiskSide::Absent;
        };
        if meta.is_dir() {
            DiskSide::Directory
        } else if meta.file_type().is_symlink() {
            std::fs::read_link(&full).map_or(DiskSide::Absent, |link| {
                DiskSide::Symlink(link.into_os_string().into_encoded_bytes())
            })
        } else {
            std::fs::read(&full).map_or(DiskSide::Absent, DiskSide::File)
        }
    }

    /// Whether the disk holds exactly `side`.
    fn holds(&self, side: &TreeSide<'_>) -> bool {
        match (self, side) {
            (DiskSide::Absent, TreeSide::Absent) => true,
            (DiskSide::File(bytes), TreeSide::File(blob)) => bytes.as_slice() == blob.content(),
            (DiskSide::Symlink(bytes), TreeSide::Symlink(blob)) => {
                bytes.as_slice() == blob.content()
            }
            (DiskSide::Directory, TreeSide::Other(_)) => true,
            _ => false,
        }
    }
}

fn drop_saved_edits(repo: &Repository) -> AppResult<()> {
    if let Ok(mut reference) = repo.find_reference(SAVED_EDITS_REF) {
        reference.delete()?;
    }
    Ok(())
}

/// Every regular file and symlink in the working tree that differs from
/// `base`, including deletions. An untracked path `target` does not hold is
/// left out (the checkout never touches it) unless `target` replaces one of
/// its parent directories with a file. Ignored files and the runtime
/// directory are left out.
fn local_edits(
    repo: &Repository,
    root: &Path,
    base: Option<&git2::Tree<'_>>,
    target: &git2::Tree<'_>,
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
        if is_runtime_path(&rel) {
            continue;
        }
        if deleted {
            edits.push(LocalEdit {
                path: rel,
                content: LocalContent::Deleted,
            });
            continue;
        }
        let in_base = base.is_some_and(|tree| tree.get_path(path).is_ok());
        if !in_base && target.get_path(path).is_err() && replaced_parent(target, &rel).is_none() {
            continue;
        }
        let full = root.join(path);
        let Ok(meta) = full.symlink_metadata() else {
            continue;
        };
        let content = if meta.is_file() {
            LocalContent::File(std::fs::read(&full)?)
        } else if meta.file_type().is_symlink() {
            LocalContent::Symlink(std::fs::read_link(&full)?)
        } else {
            continue;
        };
        edits.push(LocalEdit { path: rel, content });
    }
    Ok(edits)
}

/// Whether `rel` is taken on disk or in `tree`.
fn worktree_or_tree_has(root: &Path, tree: Option<&git2::Tree<'_>>, rel: &str) -> bool {
    root.join(rel).symlink_metadata().is_ok()
        || tree.is_some_and(|tree| tree.get_path(Path::new(rel)).is_ok())
}

/// Write a tree side at `rel`: a file's bytes, or a symlink to its target.
fn write_side(
    root: &Path,
    rel: &str,
    side: &TreeSide<'_>,
    blob: &git2::Blob<'_>,
) -> AppResult<ChangedFile> {
    match side {
        TreeSide::Symlink(_) => {
            let link = std::path::PathBuf::from(String::from_utf8_lossy(blob.content()).as_ref());
            write_symlink(root, rel, &link)
        }
        _ => write_file(root, rel, blob.content()),
    }
}

/// Replace whatever is at `rel` with a symlink to `link`.
fn write_symlink(root: &Path, rel: &str, link: &Path) -> AppResult<ChangedFile> {
    let full = root.join(rel);
    if let Some(parent) = full.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if full.symlink_metadata().is_ok() {
        std::fs::remove_file(&full)?;
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(link, &full)?;
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(link, &full)?;
    Ok(ChangedFile {
        path: rel.to_string(),
        kind: ChangeKind::Upsert,
        modified_ms: None,
    })
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

/// Whether `rel` is under the runtime directory, which a pull never touches.
fn is_runtime_path(rel: &str) -> bool {
    rel.starts_with(".reflect/")
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
            let path = to_slash_lossy(path);
            if is_runtime_path(&path) {
                continue;
            }
            out.push(ChangedFile {
                path,
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
        let abs = root.join(&change.path);
        if let Ok(bytes) = std::fs::read(&abs) {
            crate::fs::own_writes::record(root, &change.path, &bytes);
        }
        change.modified_ms = abs
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
                    add_resolved(index, root, &path, our.id, our.mode, &mut review)?;
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
                    add_resolved_unreviewed(index, root, &path, id, our.mode, &mut review)?;
                } else {
                    add_resolved(index, root, &path, our.id, our.mode, &mut review)?;
                    let copy = free_conflict_copy_path(&entry_path(&their), |path| {
                        index_or_worktree_has(index, root, path)
                    });
                    add_resolved(index, root, &copy, their.id, their.mode, &mut review)?;
                }
            }
            (Some(edited), None) | (None, Some(edited)) => {
                let path = entry_path(&edited);
                add_resolved(index, root, &path, edited.id, edited.mode, &mut review)?;
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
    root: &Path,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<()> {
    let staged = stage_resolved(index, root, path, id, mode, review)?;
    review.push(staged);
    Ok(())
}

/// Stage a resolved entry without recording it for review, unless it had to
/// move to its conflict copy path.
fn add_resolved_unreviewed(
    index: &mut Index,
    root: &Path,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<()> {
    let staged = stage_resolved(index, root, path, id, mode, review)?;
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
    root: &Path,
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
        free_conflict_copy_path(path, |path| index_or_worktree_has(index, root, path))
    } else {
        path.to_string()
    };
    let mut parent = path.as_str();
    while let Some((dir, _)) = parent.rsplit_once('/') {
        if let Some(file) = index.get_path(Path::new(dir), 0) {
            let copy =
                free_conflict_copy_path(dir, |path| index_or_worktree_has(index, root, path));
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
/// must not relocate the copy out of the file's directory. `n` above 1 gives
/// `img (conflict n).png`.
fn conflict_copy_path(rel: &str, n: u32) -> String {
    let (dir, file) = match rel.rsplit_once('/') {
        Some((dir, file)) => (Some(dir), file),
        None => (None, rel),
    };
    let label = if n > 1 {
        format!("conflict {n}")
    } else {
        "conflict".to_string()
    };
    let renamed = match file.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => format!("{stem} ({label}).{ext}"),
        _ => format!("{file} ({label})"),
    };
    match dir {
        Some(dir) => format!("{dir}/{renamed}"),
        None => renamed,
    }
}

/// The first conflict copy path of `rel` that `taken` does not claim.
fn free_conflict_copy_path(rel: &str, taken: impl Fn(&str) -> bool) -> String {
    (1..)
        .map(|n| conflict_copy_path(rel, n))
        .find(|path| !taken(path))
        .expect("an unbounded range always yields a free name")
}

/// Whether `rel` is taken in the merge index (as a file or a directory) or on
/// disk.
fn index_or_worktree_has(index: &Index, root: &Path, rel: &str) -> bool {
    let dir_prefix = format!("{rel}/");
    index.get_path(Path::new(rel), 0).is_some()
        || index
            .iter()
            .any(|entry| entry.path.starts_with(dir_prefix.as_bytes()))
        || root.join(rel).symlink_metadata().is_ok()
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
        assert_eq!(
            conflict_copy_path("assets/img.png", 2),
            "assets/img (conflict 2).png"
        );
    }
}
