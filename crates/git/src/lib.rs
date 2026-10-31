//! Git backup/sync primitives (Plan 12) with no Tauri in them.
//!
//! Rust owns the *capabilities* — init/adopt, commit, fetch, merge, push —
//! while the sync **policy** (debounce cadence, retry loop, product states,
//! GitHub specifics) lives in `@reflect/core` `sync/`. Nothing here is
//! GitHub-specific: remotes are URLs, and an HTTPS sign-in arrives per call
//! as a [`GitCredential`] presented through a callback (never embedded in
//! the URL, so never on disk).
//!
//! Every operation takes the graph root and runs on the caller's thread:
//! network fetches and pushes take seconds, so the shell runs them on a
//! blocking pool, and pins the root to the graph generation the frontend
//! received when it opened the graph. [`run_with_lock_retry`] wraps an
//! operation with the one retry after clearing a stale `.lock` file.

mod commit;
mod commit_message;
#[cfg(test)]
mod fault;
mod locks;
mod merge;
mod remote;
mod repo;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Serialize;

use reflect_types::AppResult;

pub use self::commit::{CommitOutcome, SkippedFile};
pub use self::merge::{ChangeKind, ChangedFile, MergeKind};
pub use self::remote::{GitCredential, PushOutcome, RemoteDelta, RemoteTip};

/// GitHub rejects files over 100 MB, failing the whole push; stop just under.
pub const MAX_FILE_BYTES: u64 = 95 * 1024 * 1024;

/// Snapshot of the graph's backup repository for the UI and the sync engine.
/// Deliberately cheap — refs and config only, no working-tree scan.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// Whether the graph has a repository at all (backup set up).
    pub initialized: bool,
    pub branch: Option<String>,
    pub remote_url: Option<String>,
    /// Commits ahead/behind the last-fetched remote branch (no network).
    pub ahead: usize,
    pub behind: usize,
}

pub fn status(root: &Path) -> AppResult<GitStatus> {
    if !root.join(".git").exists() {
        return Ok(GitStatus {
            initialized: false,
            branch: None,
            remote_url: None,
            ahead: 0,
            behind: 0,
        });
    }
    let repo = repo::open_existing(root)?;
    let branch = repo::current_branch(&repo).ok();
    let remote_url = repo
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().ok().map(str::to_string));
    let delta = remote::local_delta(&repo).unwrap_or(RemoteDelta {
        ahead: 0,
        behind: 0,
    });
    Ok(GitStatus {
        initialized: true,
        branch,
        remote_url,
        ahead: delta.ahead,
        behind: delta.behind,
    })
}

/// Stop backing this graph up: drop the `origin` remote. The repository and
/// its history stay intact (reconnecting re-adds a remote); the machine-level
/// GitHub credential is untouched — other graphs keep syncing.
pub fn disconnect(root: &Path) -> AppResult<GitStatus> {
    let repo = repo::open_existing(root)?;
    if repo.find_remote("origin").is_ok() {
        repo.remote_delete("origin")?;
    }
    drop(repo);
    status(root)
}

pub fn setup(
    root: &Path,
    remote_url: Option<String>,
    branch: Option<String>,
) -> AppResult<GitStatus> {
    let repo = repo::open_or_init(root)?;
    repo::ensure_gitignore_defaults(root)?;
    if let Some(url) = remote_url {
        if repo.find_remote("origin").is_ok() {
            repo.remote_set_url("origin", &url)?;
        } else {
            repo.remote("origin", &url)?;
        }
    }
    if let Some(branch) = branch {
        repo::align_branch(&repo, &branch)?;
    }
    drop(repo);
    status(root)
}

/// What one pull did: the commit of local changes, then the merge of the
/// fetched remote branch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
    /// Whether local changes were committed before the merge.
    pub committed: bool,
    /// Commits the local branch is ahead of the last-fetched remote after the
    /// merge (no network).
    pub ahead: usize,
    pub skipped_large_files: Vec<SkippedFile>,
    pub kind: MergeKind,
    /// Graph-relative paths of the conflict copies the merge wrote.
    pub review_paths: Vec<String>,
    /// Every file the merge changed on disk.
    pub changed_files: Vec<ChangedFile>,
}

/// Commit local changes and merge the fetched remote branch under one graph
/// lock, so no write lands between the commit and the checkout.
pub fn pull_all(root: &Path, message: &str, max_file_bytes: u64) -> AppResult<PullOutcome> {
    reflect_graph_io::with_graph_lock(root, || {
        #[cfg(test)]
        fault::trip(fault::FaultPoint::BeforeCommit)?;
        let commit = commit::commit_locked(root, message, max_file_bytes)?;
        let skipped: Vec<String> = commit
            .skipped_large_files
            .iter()
            .map(|file| file.path.clone())
            .collect();
        let merge = merge::merge_locked(root, &skipped)?;
        let ahead = commit::ahead_of_remote(&repo::open_existing(root)?);
        Ok(PullOutcome {
            committed: commit.committed,
            ahead,
            skipped_large_files: commit.skipped_large_files,
            kind: merge.kind,
            review_paths: merge.review_paths,
            changed_files: merge.changed_files,
        })
    })
}

/// Run a git operation against `root`, retrying once after clearing a stale
/// `.lock` file (see `locks`).
pub fn run_with_lock_retry<T>(
    root: &Path,
    operation: impl Fn(&Path) -> AppResult<T>,
) -> AppResult<T> {
    locks::retry_after_stale_lock(root, || operation(root))
}

/// Clone a backup repository into `path` (restore on a fresh machine).
pub fn clone(url: &str, path: &Path, credential: Option<GitCredential>) -> AppResult<()> {
    remote::clone(url, path, credential)
}

/// Fetch `origin` and report ahead/behind for the current branch.
pub fn fetch(root: &Path, credential: Option<GitCredential>) -> AppResult<RemoteDelta> {
    remote::fetch(root, credential)
}

/// Read the remote tip of the current branch without fetching. `url` probes
/// a remote other than `origin`.
pub fn remote_head(
    root: &Path,
    url: Option<&str>,
    credential: Option<GitCredential>,
) -> AppResult<RemoteTip> {
    remote::remote_head(root, url, credential)
}

/// Push the current branch to `origin`; rejections come back as data.
pub fn push(root: &Path, credential: Option<GitCredential>) -> AppResult<PushOutcome> {
    remote::push(root, credential)
}

/// Commit every pending change (no-op when clean). See `commit_all` in `commit.rs`.
pub fn commit_all(root: &Path, message: &str, max_file_bytes: u64) -> AppResult<CommitOutcome> {
    commit::commit_all(root, message, max_file_bytes)
}
