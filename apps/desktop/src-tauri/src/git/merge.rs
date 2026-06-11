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

use std::fs;
use std::path::Path;

use git2::build::CheckoutBuilder;
use git2::{Index, IndexEntry, MergeOptions, Repository};
use serde::Serialize;

use crate::error::AppResult;

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
pub struct MergeOutcome {
    pub kind: MergeKind,
    /// Graph-relative paths that now carry conflict markers (or a binary
    /// conflict copy). Informational — the indexer rediscovers them from
    /// content.
    pub conflicted_paths: Vec<String>,
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
        });
    };
    let annotated = repo.find_annotated_commit(remote_oid)?;
    let (analysis, _) = repo.merge_analysis(&[&annotated])?;

    if analysis.is_up_to_date() {
        return Ok(MergeOutcome {
            kind: MergeKind::UpToDate,
            conflicted_paths: Vec::new(),
        });
    }

    if analysis.is_unborn() || analysis.is_fast_forward() {
        let refname = format!("refs/heads/{branch}");
        repo.reference(&refname, remote_oid, true, "reflect sync: fast-forward")?;
        repo.set_head(&refname)?;
        // Force is safe here: the pre-merge invariant is a committed working
        // tree, so there is nothing uncommitted to clobber.
        repo.checkout_head(Some(CheckoutBuilder::new().force()))?;
        return Ok(MergeOutcome {
            kind: MergeKind::FastForward,
            conflicted_paths: Vec::new(),
        });
    }

    let mut merge_opts = MergeOptions::new();
    let mut checkout = CheckoutBuilder::new();
    checkout
        .allow_conflicts(true)
        .conflict_style_merge(true)
        .our_label(OUR_LABEL)
        .their_label(THEIR_LABEL);
    repo.merge(&[&annotated], Some(&mut merge_opts), Some(&mut checkout))?;

    let mut index = repo.index()?;
    let conflicted_paths = resolve_conflicts(&repo, root, &mut index)?;
    index.write()?;

    let tree = repo.find_tree(index.write_tree()?)?;
    let local_commit = repo.head()?.peel_to_commit()?;
    let remote_commit = repo.find_commit(remote_oid)?;
    let sig = signature(&repo)?;
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

    let kind = if conflicted_paths.is_empty() {
        MergeKind::Merged
    } else {
        MergeKind::MergedWithConflicts
    };
    Ok(MergeOutcome {
        kind,
        conflicted_paths,
    })
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
                let binary =
                    repo.find_blob(our.id)?.is_binary() || repo.find_blob(their.id)?.is_binary();
                if binary {
                    write_blob(repo, root, &our.path, our.id)?;
                    let copy = conflict_copy_path(&their.path);
                    write_blob(repo, root, &copy, their.id)?;
                    index.add_path(Path::new(&our.path))?;
                    index.add_path(Path::new(&copy))?;
                    conflicted_paths.push(our.path);
                    conflicted_paths.push(copy);
                } else {
                    // The merge checkout wrote the marker file; staging the
                    // working copy clears the conflict entries.
                    index.add_path(Path::new(&our.path))?;
                    conflicted_paths.push(our.path);
                }
            }
            (Some(our), None) => {
                // The other device deleted a note we edited: keep the edit.
                write_blob(repo, root, &our.path, our.id)?;
                index.add_path(Path::new(&our.path))?;
                conflicted_paths.push(our.path);
            }
            (None, Some(their)) => {
                // We deleted a note the other device edited: keep the edit.
                write_blob(repo, root, &their.path, their.id)?;
                index.add_path(Path::new(&their.path))?;
                conflicted_paths.push(their.path);
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
fn conflict_copy_path(rel: &str) -> String {
    match rel.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !stem.ends_with('/') => {
            format!("{stem} (conflict).{ext}")
        }
        _ => format!("{rel} (conflict)"),
    }
}
