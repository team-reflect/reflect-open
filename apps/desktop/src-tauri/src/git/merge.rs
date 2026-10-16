//! Pull-side merge: fast-forward when possible, otherwise a true merge.
//!
//! The merge is computed in memory (`merge_commits`), its conflicts are
//! resolved in that index, and the result is committed with both parents.
//! Only then is the merged tree checked out, and the branch ref moves last.
//! The repository never enters libgit2's merge state. A stop before the ref
//! moves leaves the working tree equal to HEAD or to the merge tree; the next
//! commit and merge converge from either.
//! The caller holds the graph lock and has committed the working tree, so the
//! checkout never overwrites an unsaved edit. Files a commit withheld stay as
//! they are on disk.
//! A note conflict is resolved by the conflict ladder ([`ladder::resolve`]),
//! so pulls never write conflict markers. Other files that cannot merge keep
//! both versions as conflict copies.
//! A local deletion of a file the incoming side changed keeps the incoming
//! version (an edit wins over a delete) and reports the path for review.

use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, IndexTime, MergeOptions, Repository};
use reflect_graph_paths::to_slash_lossy;
use serde::Serialize;

use crate::conflict::copy::{free_conflict_copy_path, utc_stamp};
use crate::conflict::ladder::{self, ConflictInput};
use crate::conflict::merge3;
use crate::conflict::{ConflictSide, Resolution};
use crate::error::{AppError, AppResult};

use super::repo::{clear_foreign_state, current_branch, open_existing, signature};

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

/// Merge the fetched `origin/<branch>` into the local branch. The caller
/// holds the graph lock; `skipped` lists the dirty files a commit withheld.
pub(super) fn merge_locked(root: &Path, skipped: &[String]) -> AppResult<MergeOutcome> {
    let repo = open_existing(root)?;
    pull(&repo, root, skipped)
}

#[cfg(test)]
pub(super) fn merge_remote(root: &Path) -> AppResult<MergeOutcome> {
    crate::fs::with_graph_lock(root, || merge_locked(root, &[]))
}

/// Check out `tree` over a working tree that equals HEAD, leaving the runtime
/// directory and the `skipped` dirty files alone.
fn checkout_target(repo: &Repository, tree: &git2::Tree<'_>, skipped: &[String]) -> AppResult<()> {
    // The first matching pathspec wins, so the exclusions come before `*`.
    let mut checkout = CheckoutBuilder::new();
    checkout.force().path("!.reflect");
    for path in skipped {
        checkout.path(format!("!{path}"));
    }
    checkout.path("*");
    repo.checkout_tree(tree.as_object(), Some(&mut checkout))?;
    Ok(())
}

fn pull(repo: &Repository, root: &Path, skipped: &[String]) -> AppResult<MergeOutcome> {
    clear_foreign_state(repo)?;
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
        let new_tree = repo.find_commit(remote_oid)?.tree()?;
        let mut changed_files = changed_between(repo, old_tree.as_ref(), &new_tree)?;
        // Files first, ref last: a failure in between leaves the branch where
        // it was, so the next cycle retries the pull instead of committing
        // the stale tree as a revert of it (#1405).
        #[cfg(test)]
        super::fault::trip(super::fault::FaultPoint::BeforeFastForwardCheckout)?;
        checkout_target(repo, &new_tree, skipped)?;
        stamp_modified_times(root, &mut changed_files);
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
            review_paths: Vec::new(),
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
    let ours_tree = ours.tree()?;
    let mut changed_files = changed_between(repo, Some(&ours_tree), &tree)?;

    // Same order as the fast-forward: tree first, ref last.
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::AfterMergeCommitBeforeCheckout)?;
    checkout_target(repo, &tree, skipped)?;
    stamp_modified_times(root, &mut changed_files);
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeMergeRefMove)?;
    repo.reference_matching(
        &format!("refs/heads/{branch}"),
        merge_oid,
        true,
        head_oid,
        message,
    )?;

    Ok(MergeOutcome {
        kind: MergeKind::Merged,
        review_paths,
        changed_files,
    })
}

/// Resolve a note conflict of the in-memory merge through the ladder. Both
/// sides are commit blobs, so their commit times order them on every device.
fn merge_note(
    base: Option<&[u8]>,
    ours: (&[u8], &git2::Commit<'_>),
    theirs: (&[u8], &git2::Commit<'_>),
) -> AppResult<Vec<u8>> {
    let ours_side = text_side(ours.0, OUR_LABEL, commit_ms(ours.1))?;
    let theirs_side = text_side(theirs.0, THEIR_LABEL, commit_ms(theirs.1))?;
    let base = base.map(text_of).transpose()?;
    let content = match ladder::resolve(ConflictInput {
        base,
        sides: (ours_side, theirs_side),
        merge_loop_detected: false,
    })? {
        Resolution::AlreadyResolved => return Ok(ours.0.to_vec()),
        Resolution::Merged { content } | Resolution::Reconciled { content } => content,
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

fn commit_ms(commit: &git2::Commit<'_>) -> u64 {
    commit.time().seconds().max(0) as u64 * 1000
}

/// Whether `rel` is under the runtime directory, which a pull never touches.
fn is_runtime_path(rel: &str) -> bool {
    rel.starts_with(".reflect/")
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
/// - **edit vs delete**: keep the edited version, never silently delete;
/// - **deleted on both**: confirm the removal;
/// - **note (`.md`)**: the ladder's merged text;
/// - **other text**: the three-way merge when it is clean;
/// - **anything else** (binary, symlink, an unclean text merge): keep ours at
///   the path and the other device's version beside it as
///   `name (conflict <stamp> <hash8>).ext`;
/// - **submodule**: keep ours.
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
    let stamp = utc_stamp(theirs.time().seconds());
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
                    add_resolved(index, root, &stamp, &path, our.id, our.mode, &mut review)?;
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
                let all_text = plain
                    && is_text(&our_blob)
                    && is_text(&their_blob)
                    && ancestor_blob.as_ref().is_none_or(is_text);
                let base = ancestor_blob.as_ref().map(|blob| blob.content());
                let merged = if !all_text {
                    None
                } else if reflect_graph_paths::is_note(&path) {
                    Some(merge_note(
                        base,
                        (our_blob.content(), ours),
                        (their_blob.content(), theirs),
                    )?)
                } else {
                    let ours_side = text_side(our_blob.content(), OUR_LABEL, commit_ms(ours))?;
                    let theirs_side =
                        text_side(their_blob.content(), THEIR_LABEL, commit_ms(theirs))?;
                    merge3::diff3(
                        base.map(text_of).transpose()?.unwrap_or(""),
                        &ours_side,
                        &theirs_side,
                    )?
                    .map(String::into_bytes)
                };
                if let Some(merged) = merged {
                    let id = repo.blob(&merged)?;
                    add_resolved_unreviewed(index, root, &stamp, &path, id, our.mode, &mut review)?;
                } else {
                    add_resolved_unreviewed(
                        index,
                        root,
                        &stamp,
                        &path,
                        our.id,
                        our.mode,
                        &mut review,
                    )?;
                    let copy = free_conflict_copy_path(
                        &path,
                        &stamp,
                        &their.id.to_string()[..8],
                        |path| index_or_worktree_has(index, root, path),
                    );
                    add_resolved(
                        index,
                        root,
                        &stamp,
                        &copy,
                        their.id,
                        their.mode,
                        &mut review,
                    )?;
                }
            }
            (Some(edited), None) | (None, Some(edited)) => {
                let path = entry_path(&edited);
                add_resolved(
                    index,
                    root,
                    &stamp,
                    &path,
                    edited.id,
                    edited.mode,
                    &mut review,
                )?;
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
    stamp: &str,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<()> {
    let staged = stage_resolved(index, root, stamp, path, id, mode, review)?;
    review.push(staged);
    Ok(())
}

/// Stage a resolved entry without recording it for review, unless it had to
/// move to its conflict copy path.
fn add_resolved_unreviewed(
    index: &mut Index,
    root: &Path,
    stamp: &str,
    path: &str,
    id: git2::Oid,
    mode: u32,
    review: &mut Vec<String>,
) -> AppResult<()> {
    let staged = stage_resolved(index, root, stamp, path, id, mode, review)?;
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
    stamp: &str,
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
        let hash8 = id.to_string();
        free_conflict_copy_path(path, stamp, &hash8[..8], |path| {
            index_or_worktree_has(index, root, path)
        })
    } else {
        path.to_string()
    };
    let mut parent = path.as_str();
    while let Some((dir, _)) = parent.rsplit_once('/') {
        if let Some(file) = index.get_path(Path::new(dir), 0) {
            let hash8 = file.id.to_string();
            let copy = free_conflict_copy_path(dir, stamp, &hash8[..8], |path| {
                index_or_worktree_has(index, root, path)
            });
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
