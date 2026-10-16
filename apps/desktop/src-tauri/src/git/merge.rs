//! Pull-side merge: fast-forward when possible, otherwise a true merge.
//!
//! The merge is computed in memory (`merge_commits`), its conflicts are
//! resolved in that index, and the result is committed with both parents.
//! Only then is the merged tree checked out, and the branch ref moves last.
//! The repository never enters libgit2's merge state, so a stop at any point
//! leaves nothing for the next cycle to clean up. A text conflict is
//! committed as labeled marker text:
//!
//! ```text
//! <<<<<<< this device
//! the local version
//! =======
//! the other device's version
//! >>>>>>> other device
//! ```

use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, IndexTime, MergeFileOptions, MergeOptions, Repository};
use reflect_graph_paths::to_slash_lossy;
use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::repo::{current_branch, ensure_clean_state, open_existing, signature};

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
}

/// Merge the fetched `origin/<branch>` into the local branch. Pre-condition
/// (the sync engine guarantees it): local changes are already committed.
pub(super) fn merge_remote(root: &Path) -> AppResult<MergeOutcome> {
    crate::fs::with_graph_lock(root, || merge_remote_locked(root))
}

fn merge_remote_locked(root: &Path) -> AppResult<MergeOutcome> {
    let repo = open_existing(root)?;
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
        // Capture the outgoing tree before anything moves (None on unborn).
        let old_oid = repo.head().ok().and_then(|head| head.target());
        let old_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
        let new_tree = repo.find_commit(remote_oid)?.tree()?;
        let mut changed_files = changed_between(&repo, old_tree.as_ref(), &new_tree)?;
        // Files first, ref last: a failure in between leaves the branch where
        // it was, so the next cycle retries the pull instead of committing
        // the stale tree as a revert of it (#1405). Force is safe here: the
        // pre-merge invariant is a committed working tree, so there is
        // nothing uncommitted to clobber.
        #[cfg(test)]
        super::fault::trip(super::fault::FaultPoint::BeforeFastForwardCheckout)?;
        repo.checkout_tree(new_tree.as_object(), Some(CheckoutBuilder::new().force()))?;
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
        // Stamp mtimes only now — the checkout above is what wrote the files.
        stamp_modified_times(root, &mut changed_files);
        return Ok(MergeOutcome {
            kind: MergeKind::FastForward,
            conflicted_paths: Vec::new(),
            changed_files,
        });
    }

    let ours = repo.head()?.peel_to_commit()?;
    let head_oid = ours.id();
    let theirs = repo.find_commit(remote_oid)?;
    let mut index = repo.merge_commits(&ours, &theirs, Some(&MergeOptions::new()))?;
    let conflicted_paths = resolve_index_conflicts(&repo, &mut index)?;
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeMergeCommit)?;

    let tree = repo.find_tree(index.write_tree_to(&repo)?)?;
    let sig = signature(&repo)?;
    let message = if conflicted_paths.is_empty() {
        "Merge changes from other devices"
    } else {
        "Merge changes from other devices (conflicts to review)"
    };
    let merge_oid = repo.commit(None, &sig, &sig, message, &tree, &[&ours, &theirs])?;
    let mut changed_files = changed_between(&repo, Some(&ours.tree()?), &tree)?;

    // Same order as the fast-forward: tree first, ref last. A stop after the
    // checkout leaves the branch on `ours` with the merged files on disk; the
    // next cycle commits them as a local change and merges again.
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::AfterMergeCommitBeforeCheckout)?;
    repo.checkout_tree(tree.as_object(), Some(CheckoutBuilder::new().force()))?;
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeMergeRefMove)?;
    repo.reference_matching(
        &format!("refs/heads/{branch}"),
        merge_oid,
        true,
        head_oid,
        message,
    )?;
    stamp_modified_times(root, &mut changed_files);

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
/// - **text vs text**: the labeled marker text of the three-way merge;
/// - **edit vs delete**: keep the edited version, never silently delete;
/// - **binary vs binary**: keep ours at the path and the other device's
///   version alongside (`name (conflict).ext`);
/// - **deleted on both**: confirm the removal.
///
/// Returns the paths the user should review.
fn resolve_index_conflicts(repo: &Repository, index: &mut Index) -> AppResult<Vec<String>> {
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
                let our_blob = repo.find_blob(our.id)?;
                let their_blob = repo.find_blob(their.id)?;
                let path = entry_path(&our);
                if is_text(&our_blob) && is_text(&their_blob) {
                    let ancestor = match conflict.ancestor {
                        Some(ancestor) => ancestor,
                        None => stage0_entry(&path, repo.blob(b"")?, our.mode),
                    };
                    let mut opts = MergeFileOptions::new();
                    opts.our_label(OUR_LABEL)
                        .their_label(THEIR_LABEL)
                        .style_standard(true);
                    let merged =
                        repo.merge_file_from_index(&ancestor, &our, &their, Some(&mut opts))?;
                    let id = repo.blob(merged.content())?;
                    index.add(&stage0_entry(&path, id, our.mode))?;
                    review.push(path);
                } else {
                    let copy = conflict_copy_path(&entry_path(&their));
                    index.add(&stage0_entry(&path, our.id, our.mode))?;
                    index.add(&stage0_entry(&copy, their.id, their.mode))?;
                    review.push(path);
                    review.push(copy);
                }
            }
            (Some(edited), None) | (None, Some(edited)) => {
                let path = entry_path(&edited);
                index.add(&stage0_entry(&path, edited.id, edited.mode))?;
                review.push(path);
            }
            (None, None) => {}
        }
    }
    if index.has_conflicts() {
        return Err(AppError::io("the merge left unresolved conflicts"));
    }
    Ok(review)
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
