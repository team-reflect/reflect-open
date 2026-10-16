//! Git backup/sync primitives.
//!
//! Rust owns the *capabilities* — init/adopt, commit, fetch, merge, push —
//! while the sync **policy** (debounce cadence, retry loop, product states,
//! GitHub specifics) lives in `@reflect/core` `sync/`. Nothing here is
//! GitHub-specific: remotes are URLs, and an HTTPS sign-in arrives per call
//! as a [`GitCredential`] presented through a callback (never embedded in
//! the URL, so never on disk).
//!
//! All operations run on blocking threads (network fetches/pushes take
//! seconds) and are **generation-gated** like file writes: every command takes
//! the `generation` the frontend received when its graph was opened and
//! resolves the root through `crate::fs::root_for_generation`, which fails
//! when the active graph's generation has since moved (the user switched
//! graphs after the command was issued). A stale command errors loudly instead
//! of acting on the new graph, so commands never interleave across graphs.
//! The one exception is `git_clone`, which runs before any graph is open.

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

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::State;

use crate::blocking::run_blocking;

use crate::error::AppResult;
use crate::fs::GraphState;

use self::commit::{CommitOutcome, SkippedFile};
use self::merge::{ChangedFile, MergeKind};
use self::remote::{GitCredential, PushOutcome, RemoteDelta, RemoteTip};

/// GitHub rejects files over 100 MB, failing the whole push; stop just under.
const MAX_FILE_BYTES: u64 = 95 * 1024 * 1024;

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

fn status(root: &Path) -> AppResult<GitStatus> {
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
fn disconnect(root: &Path) -> AppResult<GitStatus> {
    let repo = repo::open_existing(root)?;
    if repo.find_remote("origin").is_ok() {
        repo.remote_delete("origin")?;
    }
    drop(repo);
    status(root)
}

fn setup(root: &Path, remote_url: Option<String>, branch: Option<String>) -> AppResult<GitStatus> {
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

/// Run a git operation on a blocking thread, retrying once after clearing a
/// stale `.lock` file.
async fn run_git<T, F>(root: PathBuf, operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: Fn(&Path) -> AppResult<T> + Send + 'static,
{
    run_blocking(move || locks::retry_after_stale_lock(&root, || operation(&root))).await
}

/// Snapshot the backup repository (cheap, no network).
#[tauri::command]
pub async fn git_status(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || status(&root)).await
}

/// Initialize (or adopt) the graph's repository, optionally point `origin` at
/// `remote_url`, and align the local branch with `branch` (the remote's
/// default — fetch/merge/push must target the branch the backup repo actually
/// uses, e.g. an existing repo on `master` while fresh graphs init `main`).
/// Idempotent.
#[tauri::command]
pub async fn git_setup(
    remote_url: Option<String>,
    branch: Option<String>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_git(root, move |root| {
        crate::fs::with_graph_lock(root, || setup(root, remote_url.clone(), branch.clone()))
    })
    .await
}

/// Stop backing this graph up (drop `origin`; repo, history, and the
/// machine-level credential all stay).
#[tauri::command]
pub async fn git_disconnect(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_git(root, |root| {
        crate::fs::with_graph_lock(root, || disconnect(root))
    })
    .await
}

/// Clone a backup repository into `path` (restore on a fresh machine). Runs
/// before any graph is open, so it takes an absolute destination rather than
/// a graph-relative path; the caller opens the result as a graph afterwards.
#[tauri::command]
pub async fn git_clone(
    url: String,
    path: String,
    credential: Option<GitCredential>,
) -> AppResult<()> {
    run_blocking(move || remote::clone(&url, Path::new(&path), credential)).await
}

/// Commit every pending change (no-op when clean). See [`commit::commit_all`].
#[tauri::command]
pub async fn git_commit_all(
    message: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<CommitOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    let started = std::time::Instant::now();
    let outcome = run_git(root, move |root| {
        commit::commit_all(root, &message, MAX_FILE_BYTES)
    })
    .await;
    if let Ok(outcome) = &outcome {
        tracing::info!(
            committed = outcome.committed,
            ahead = outcome.ahead,
            elapsed_ms = started.elapsed().as_millis() as u64,
            "git_commit_all"
        );
    }
    outcome
}

/// Fetch `origin` and report ahead/behind for the current branch.
#[tauri::command]
pub async fn git_fetch(
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<RemoteDelta> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_git(root, move |root| remote::fetch(root, credential.clone())).await
}

/// Read the remote tip of the current branch without fetching.
#[tauri::command]
pub async fn git_remote_head(
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<RemoteTip> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || remote::remote_head(&root, credential)).await
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
fn pull_all(root: &Path, message: &str, max_file_bytes: u64) -> AppResult<PullOutcome> {
    crate::fs::with_graph_lock(root, || {
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

/// Commit local changes, then merge the fetched remote branch.
#[tauri::command]
pub async fn git_pull(
    message: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<PullOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    let outcome = run_git(root, move |root| pull_all(root, &message, MAX_FILE_BYTES)).await;
    // Invalidate on both arms: a failed pull can leave the tree half written.
    let root = crate::fs::root_for_generation(&state, generation)?;
    crate::fs::invalidate_file_catalog(&state, &root);
    outcome
}

/// Push the current branch to `origin`; rejections come back as data so the
/// sync engine can branch on them.
#[tauri::command]
pub async fn git_push(
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<PushOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_git(root, move |root| remote::push(root, credential.clone())).await
}
