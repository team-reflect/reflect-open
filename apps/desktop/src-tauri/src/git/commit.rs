//! Stage-everything commit with the large-file guardrail.

use std::cell::RefCell;
use std::path::{Path, PathBuf};

use git2::{Index, IndexAddOption};
use serde::Serialize;

use crate::error::AppResult;

use super::commit_message::message_for_commit;
use super::repo::{ensure_clean_state, open_existing, signature};
use super::runtime;

/// A file whose *changes* were withheld from staging because it is at/above
/// the size guardrail. Oversized-but-unchanged files are not reported — their
/// old version is already in the backup.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    /// Graph-relative path (forward-slashed) of the withheld file.
    pub path: String,
    pub size: u64,
}

/// Result of a commit attempt. `committed: false` means the tree was clean.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub committed: bool,
    pub sha: Option<String>,
    /// Commits the local branch is ahead of the last-fetched remote (no
    /// network). The sync engine skips the push entirely when a debounced
    /// pass finds nothing committed and nothing ahead — pull-applied watcher
    /// events would otherwise buy a pointless network negotiation each time.
    pub ahead: usize,
    pub skipped_large_files: Vec<SkippedFile>,
}

/// Stage every change under the graph and commit. Returns `committed: false`
/// when the staged tree already matches HEAD — the sync engine uses that
/// (with `ahead`) to skip the network entirely, which is what makes the loop
/// safe: pull-applied writes match HEAD and produce no-ops.
pub(super) fn commit_all(
    root: &Path,
    fallback_message: &str,
    max_file_bytes: u64,
) -> AppResult<CommitOutcome> {
    let repo = open_existing(root)?;
    ensure_clean_state(&repo)?;
    repo.add_ignore_rule("/.reflect/")?;

    let mut index = repo.index()?;
    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    let mut committed_index = Index::new()?;
    if let Some(parent) = &parent {
        committed_index.read_tree(&parent.tree()?)?;
    }
    runtime::remove_from_index(&mut index)?;
    let skipped = add_all_with_size_guard(&mut index, &committed_index, root, max_file_bytes)?;
    if parent.is_none() && index.is_empty() {
        return Ok(CommitOutcome {
            committed: false,
            sha: None,
            ahead: ahead_of_remote(&repo),
            skipped_large_files: skipped,
        });
    }

    let tree_id = index.write_tree()?;
    if let Some(parent) = &parent {
        if parent.tree_id() == tree_id {
            return Ok(CommitOutcome {
                committed: false,
                sha: None,
                ahead: ahead_of_remote(&repo),
                skipped_large_files: skipped,
            });
        }
    }

    let tree = repo.find_tree(tree_id)?;
    let message = message_for_commit(&repo, parent.as_ref(), &tree, fallback_message)?;
    let sig = signature(&repo)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)?;
    Ok(CommitOutcome {
        committed: true,
        sha: Some(oid.to_string()),
        ahead: ahead_of_remote(&repo),
        skipped_large_files: skipped,
    })
}

/// Stage every change (adds, edits, deletes — `.gitignore` respected) into
/// `index` and write it, withholding files at/above `max_file_bytes`: GitHub
/// rejects >100 MB files and the rejection fails the *whole* push, so one
/// oversized video must not break backup for everything else. Returns the
/// files whose changes were withheld.
fn add_all_with_size_guard(
    index: &mut Index,
    committed_index: &Index,
    root: &Path,
    max_file_bytes: u64,
) -> AppResult<Vec<SkippedFile>> {
    // Size + mtime already in the index, so the guard can tell "oversized and
    // unchanged" (skip silently — its old version is already backed up) from
    // "oversized changes being withheld" (skip and report). Size alone would
    // miss a same-length edit; matching git's own stat-based change detection
    // (mtime, at nanosecond precision where the index recorded it) closes
    // that without hashing gigabytes. When the index entry carries no nsec
    // component (libgit2 built without USE_NSEC), the comparison falls back
    // to whole seconds — a same-length edit inside that second is then
    // reported as withheld rather than silently matched, erring toward the
    // warning.
    let tracked_entries: std::collections::HashMap<Vec<u8>, git2::IndexEntry> = index
        .iter()
        .map(|entry| (entry.path.clone(), entry))
        .collect();

    let skipped: RefCell<Vec<SkippedFile>> = RefCell::new(Vec::new());
    let withheld: RefCell<Vec<PathBuf>> = RefCell::new(Vec::new());
    let mut size_guard = |path: &Path, _spec: &[u8]| -> i32 {
        if runtime::is_runtime_path(path) {
            return 1;
        }
        let Ok(meta) = root.join(path).metadata() else {
            // Deleted file: let the staging proceed so the removal is recorded.
            return 0;
        };
        if !meta.is_file() || meta.len() < max_file_bytes {
            return 0;
        }
        let rel = path.to_string_lossy().replace('\\', "/");
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok());
        let (file_secs, file_nsecs) = mtime
            .map(|duration| (duration.as_secs() as i32, duration.subsec_nanos()))
            .unwrap_or((0, 0));
        let committed = committed_index.get_path(path, 0);
        let unchanged = match committed.as_ref().and_then(|entry| {
            tracked_entries
                .get(&entry.path)
                .map(|tracked| (entry, tracked))
        }) {
            Some((entry, tracked)) => {
                entry.id == tracked.id
                    && u64::from(tracked.file_size) == meta.len()
                    && tracked.mtime.seconds() == file_secs
                    && tracked.mtime.nanoseconds() != 0
                    && tracked.mtime.nanoseconds() == file_nsecs
            }
            None => false,
        };
        withheld.borrow_mut().push(path.to_path_buf());
        let mut skipped = skipped.borrow_mut();
        if !unchanged && !skipped.iter().any(|file| file.path == rel) {
            skipped.push(SkippedFile {
                path: rel,
                size: meta.len(),
            });
        }
        1 // keep the oversized content out of the index either way
    };

    // add_all/update_all can skip their callback for files already staged
    // with matching stats. Filter the existing index first so pre-staged
    // oversized additions and updates cannot bypass the size guardrail.
    index.remove_all(
        ["*"],
        Some(&mut |path: &Path, spec: &[u8]| {
            if size_guard(path, spec) == 1 {
                0
            } else {
                1
            }
        }),
    )?;
    index.add_all(["*"], IndexAddOption::DEFAULT, Some(&mut size_guard))?;
    // add_all stages new + modified paths; update_all records deletions of
    // tracked files whose working copy is gone (and re-checks sizes for
    // tracked files that have since grown past the guardrail).
    index.update_all(["*"], Some(&mut size_guard))?;
    // A file may already have oversized content staged by another Git tool.
    // Merely skipping add_all would commit that blob despite the guardrail.
    // Retain its last committed version, or keep a new large file untracked.
    for path in withheld.into_inner() {
        match committed_index.get_path(&path, 0) {
            Some(entry) => {
                let restore = tracked_entries
                    .get(&entry.path)
                    .filter(|tracked| tracked.id == entry.id)
                    .unwrap_or(&entry);
                index.add(restore)?;
            }
            None => {
                if index.get_path(&path, 0).is_some() {
                    index.remove_path(&path)?;
                }
            }
        }
    }
    index.write()?;
    Ok(skipped.into_inner())
}

/// Ahead-count vs the last-fetched remote branch. When it can't be computed
/// it reports `1` so the engine errs toward pushing, never toward skipping.
fn ahead_of_remote(repo: &git2::Repository) -> usize {
    super::remote::local_delta(repo)
        .map(|delta| delta.ahead)
        .unwrap_or(1)
}
