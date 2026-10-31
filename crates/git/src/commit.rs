//! Stage-everything commit with the large-file guardrail.

use std::cell::RefCell;
use std::path::Path;

use git2::{Index, IndexAddOption, IndexEntry};
use reflect_graph_paths::to_slash_lossy;
use serde::Serialize;

use reflect_types::AppResult;

use super::commit_message::message_for_commit;
use super::repo::{clear_foreign_state, open_existing, reattach_head, signature, stage0_entry};

/// A file whose changes were withheld because it is at or above the size
/// guardrail. An unchanged oversized file is not reported.
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
    /// network).
    pub ahead: usize,
    pub skipped_large_files: Vec<SkippedFile>,
}

/// Stage every change under the graph and commit. Returns `committed: false`
/// when the staged tree already matches HEAD.
pub(super) fn commit_all(
    root: &Path,
    fallback_message: &str,
    max_file_bytes: u64,
) -> AppResult<CommitOutcome> {
    #[cfg(test)]
    super::fault::trip(super::fault::FaultPoint::BeforeCommit)?;
    reflect_graph_io::with_graph_lock(root, || {
        commit_locked(root, fallback_message, max_file_bytes)
    })
}

pub(super) fn commit_locked(
    root: &Path,
    fallback_message: &str,
    max_file_bytes: u64,
) -> AppResult<CommitOutcome> {
    let repo = open_existing(root)?;
    clear_foreign_state(&repo)?;
    reattach_head(&repo)?;
    // A synced `.reflect/` corrupts the index on every other device.
    repo.add_ignore_rule("/.reflect/")?;

    let mut index = repo.index()?;
    let mut skipped = add_all_with_size_guard(&mut index, root, max_file_bytes)?;
    // The ignore rule keeps only new paths out: drop a tracked `.reflect/`.
    index.remove_dir(Path::new(".reflect"), 0)?;
    withhold_oversized_entries(&repo, &mut index, root, max_file_bytes, &mut skipped)?;
    keep_head_entries_of_skipped(&repo, &mut index, &skipped)?;
    index.write()?;

    let parent = repo.head().ok().and_then(|head| head.peel_to_commit().ok());
    if parent.is_none() && index.is_empty() {
        return Ok(CommitOutcome {
            committed: false,
            sha: None,
            ahead: ahead_of_remote(&repo),
            skipped_large_files: skipped,
        });
    }

    let tree_id = index.write_tree()?;
    if let Some(parent) = &parent
        && parent.tree_id() == tree_id
    {
        return Ok(CommitOutcome {
            committed: false,
            sha: None,
            ahead: ahead_of_remote(&repo),
            skipped_large_files: skipped,
        });
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

/// Stage every change into `index` and write it, withholding files at or
/// above `max_file_bytes`: one file over GitHub's 100 MB limit fails the whole
/// push. Returns the files whose changes were withheld.
fn add_all_with_size_guard(
    index: &mut Index,
    root: &Path,
    max_file_bytes: u64,
) -> AppResult<Vec<SkippedFile>> {
    // Size and mtime (nanoseconds when the index has them) tell an unchanged
    // oversized file, skipped silently, from a withheld change, reported.
    let tracked_stats: std::collections::HashMap<String, (u32, i32, u32)> = index
        .iter()
        .map(|entry| {
            (
                String::from_utf8_lossy(&entry.path).into_owned(),
                (
                    entry.file_size,
                    entry.mtime.seconds(),
                    entry.mtime.nanoseconds(),
                ),
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
        let rel = to_slash_lossy(path);
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok());
        let (file_secs, file_nsecs) = mtime
            .map(|duration| (duration.as_secs() as i32, duration.subsec_nanos()))
            .unwrap_or((0, 0));
        let unchanged = match tracked_stats.get(&rel) {
            Some(&(size, secs, nsecs)) => {
                size == meta.len() as u32
                    && secs == file_secs
                    && (nsecs == 0 || nsecs == file_nsecs)
            }
            None => false,
        };
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
    // `update_all` records deletions, which `add_all` does not.
    index.update_all(["*"], Some(&mut size_guard))?;
    index.write()?;
    Ok(skipped.into_inner())
}

/// Withhold index entries with oversized content the add-time guard never
/// saw. A path `HEAD` tracks keeps its committed blob; a new path leaves the
/// index.
fn withhold_oversized_entries(
    repo: &git2::Repository,
    index: &mut Index,
    root: &Path,
    max_file_bytes: u64,
    skipped: &mut Vec<SkippedFile>,
) -> AppResult<()> {
    let head_tree = repo.head().ok().and_then(|head| head.peel_to_tree().ok());
    let oversized: Vec<(IndexEntry, String, u64)> = index
        .iter()
        .filter_map(|entry| {
            let rel = String::from_utf8_lossy(&entry.path).into_owned();
            let size = root.join(&rel).metadata().ok()?.len();
            (size >= max_file_bytes).then_some((entry, rel, size))
        })
        .collect();
    for (entry, rel, size) in oversized {
        let path = Path::new(&rel);
        let committed = head_tree.as_ref().and_then(|tree| tree.get_path(path).ok());
        match committed {
            Some(committed) if committed.id() == entry.id => continue, // unchanged, already backed up
            Some(committed) => index.add(&IndexEntry {
                id: committed.id(),
                mode: committed.filemode() as u32,
                file_size: 0,
                ..entry
            })?,
            None => index.remove_path(path)?,
        }
        if !skipped.iter().any(|file| file.path == rel) {
            skipped.push(SkippedFile { path: rel, size });
        }
    }
    Ok(())
}

/// A withheld file that is not in the index but that `HEAD` tracks keeps the
/// committed blob. Otherwise the commit would record a deletion.
fn keep_head_entries_of_skipped(
    repo: &git2::Repository,
    index: &mut Index,
    skipped: &[SkippedFile],
) -> AppResult<()> {
    let Some(head_tree) = repo.head().ok().and_then(|head| head.peel_to_tree().ok()) else {
        return Ok(());
    };
    for file in skipped {
        let path = Path::new(&file.path);
        if index.get_path(path, 0).is_some() {
            continue;
        }
        let Ok(committed) = head_tree.get_path(path) else {
            continue;
        };
        index.add(&stage0_entry(
            &file.path,
            committed.id(),
            committed.filemode() as u32,
        ))?;
    }
    Ok(())
}

/// Ahead-count vs the last-fetched remote branch. When it can't be computed
/// it reports `1` so the engine errs toward pushing, never toward skipping.
pub(super) fn ahead_of_remote(repo: &git2::Repository) -> usize {
    super::remote::local_delta(repo)
        .map(|delta| delta.ahead)
        .unwrap_or(1)
}
