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

    let mut merge_opts = MergeOptions::new();
    let mut checkout = CheckoutBuilder::new();
    checkout
        .allow_conflicts(true)
        .conflict_style_merge(true)
        .our_label(OUR_LABEL)
        .their_label(THEIR_LABEL);
    repo.merge(&[&annotated], Some(&mut merge_opts), Some(&mut checkout))?;

    // From here the repo carries MERGE_* state; a failure that leaves it
    // behind would trip `ensure_clean_state` on every later cycle and wedge
    // sync until a manual repair — exactly what this design forbids. Clear it
    // on every path; the next cycle re-derives anything a failed attempt lost.
    let result = complete_merge(&repo, root, remote_oid);
    if result.is_err() {
        let _ = repo.cleanup_state();
    }
    let (conflicted_paths, changed_files) = result?;

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

/// The post-`repo.merge` half: materialize conflicts, commit the merge with
/// both parents, and clear the merge state. Split out so [`merge_remote`] can
/// guarantee `cleanup_state` runs even when any step here fails. Returns the
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
    // The working tree is final here (merge checkout + conflict resolution
    // wrote everything), so the stamped mtimes are the files' real ones.
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
