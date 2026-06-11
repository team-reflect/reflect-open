//! Stage-everything commit with the large-file guardrail.

use std::cell::RefCell;
use std::path::Path;

use git2::IndexAddOption;
use serde::Serialize;

use crate::error::AppResult;

use super::repo::{ensure_clean_state, open_existing, signature};

/// A file excluded from backup because it exceeds the size guardrail.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub size: u64,
}

/// Result of a commit attempt. `committed: false` means the tree was clean.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub committed: bool,
    pub sha: Option<String>,
    pub skipped_large_files: Vec<SkippedFile>,
}

/// Stage every change under the graph (adds, edits, deletes — `.gitignore`
/// respected) and commit. Files at/above `max_file_bytes` are left unstaged
/// and reported: GitHub rejects >100 MB files and the rejection fails the
/// *whole* push, so one oversized video must not break backup for everything
/// else. Skips the commit entirely when nothing changed, which is what makes
/// the sync loop safe — pull-applied writes match HEAD and produce no-ops.
pub(super) fn commit_all(
    root: &Path,
    message: &str,
    max_file_bytes: u64,
) -> AppResult<CommitOutcome> {
    let repo = open_existing(root)?;
    ensure_clean_state(&repo)?;

    let mut index = repo.index()?;
    // Size + mtime already in the index, so the guard can tell "oversized and
    // unchanged" (skip silently — its old version is already backed up) from
    // "oversized changes being withheld" (skip and report). Size alone would
    // miss a same-length edit; matching git's own stat-based change detection
    // (mtime) closes that without hashing gigabytes.
    let tracked_stats: std::collections::HashMap<String, (u32, i32)> = index
        .iter()
        .map(|entry| {
            (
                String::from_utf8_lossy(&entry.path).into_owned(),
                (entry.file_size, entry.mtime.seconds()),
            )
        })
        .collect();

    let skipped: RefCell<Vec<SkippedFile>> = RefCell::new(Vec::new());
    let mut size_guard = |path: &Path, _spec: &[u8]| -> i32 {
        let Ok(meta) = root.join(path).metadata() else {
            // Deleted file: let the staging proceed so the removal is recorded.
            return 0;
        };
        if !meta.is_file() || meta.len() < max_file_bytes {
            return 0;
        }
        let rel = path.to_string_lossy().replace('\\', "/");
        let mtime_secs = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i32)
            .unwrap_or(0);
        let unchanged = tracked_stats.get(&rel) == Some(&(meta.len() as u32, mtime_secs));
        let mut skipped = skipped.borrow_mut();
        if !unchanged && !skipped.iter().any(|file| file.path == rel) {
            skipped.push(SkippedFile {
                path: rel,
                size: meta.len(),
            });
        }
        1 // keep the oversized content out of the index either way
    };

    index.add_all(["*"], IndexAddOption::DEFAULT, Some(&mut size_guard))?;
    // add_all stages new + modified paths; update_all records deletions of
    // tracked files whose working copy is gone (and re-checks sizes for
    // tracked files that have since grown past the guardrail).
    index.update_all(["*"], Some(&mut size_guard))?;
    index.write()?;

    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if parent.is_none() && index.is_empty() {
        return Ok(CommitOutcome {
            committed: false,
            sha: None,
            skipped_large_files: skipped.into_inner(),
        });
    }

    let tree_id = index.write_tree()?;
    if let Some(parent) = &parent {
        if parent.tree_id() == tree_id {
            return Ok(CommitOutcome {
                committed: false,
                sha: None,
                skipped_large_files: skipped.into_inner(),
            });
        }
    }

    let tree = repo.find_tree(tree_id)?;
    let sig = signature(&repo)?;
    let parents: Vec<&git2::Commit> = parent.iter().collect();
    let oid = repo.commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)?;
    Ok(CommitOutcome {
        committed: true,
        sha: Some(oid.to_string()),
        skipped_large_files: skipped.into_inner(),
    })
}
