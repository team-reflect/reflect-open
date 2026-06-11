//! Git backup/sync primitives (Plan 12).
//!
//! Rust owns the *capabilities* — init/adopt, commit, fetch, merge, push —
//! while the sync **policy** (debounce cadence, retry loop, product states,
//! GitHub specifics) lives in `@reflect/core` `sync/`. Nothing here is
//! GitHub-specific: remotes are URLs, credentials arrive per call through a
//! callback (never embedded in the URL, so never on disk).
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
mod merge;
mod remote;
mod repo;
#[cfg(test)]
mod tests;

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::fs::GraphState;

use self::commit::CommitOutcome;
use self::merge::MergeOutcome;
use self::remote::{PushOutcome, RemoteDelta};

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
    /// The repository state is not `Clean` — a merge/rebase the user started
    /// outside Reflect (e.g. via the git CLI) is in progress. Sync refuses to
    /// run until it is finished or aborted.
    pub in_progress: bool,
}

fn status(root: &Path) -> AppResult<GitStatus> {
    if !root.join(".git").exists() {
        return Ok(GitStatus {
            initialized: false,
            branch: None,
            remote_url: None,
            ahead: 0,
            behind: 0,
            in_progress: false,
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
        in_progress: repo.state() != git2::RepositoryState::Clean,
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
    repo::ensure_reflect_ignored(root)?;
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

async fn run_blocking<T, F>(task: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> AppResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|err| AppError::io(format!("git task panicked: {err}")))?
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
    run_blocking(move || setup(&root, remote_url, branch)).await
}

/// Stop backing this graph up (drop `origin`; repo, history, and the
/// machine-level credential all stay).
#[tauri::command]
pub async fn git_disconnect(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || disconnect(&root)).await
}

/// Clone a backup repository into `path` (restore on a fresh machine). Runs
/// before any graph is open, so it takes an absolute destination rather than
/// a graph-relative path; the caller opens the result as a graph afterwards.
#[tauri::command]
pub async fn git_clone(url: String, path: String, token: Option<String>) -> AppResult<()> {
    run_blocking(move || remote::clone(&url, Path::new(&path), token)).await
}

/// Commit every pending change (no-op when clean). See [`commit::commit_all`].
#[tauri::command]
pub async fn git_commit_all(
    message: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<CommitOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || commit::commit_all(&root, &message, MAX_FILE_BYTES)).await
}

/// Fetch `origin` and report ahead/behind for the current branch.
#[tauri::command]
pub async fn git_fetch(
    token: Option<String>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<RemoteDelta> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || remote::fetch(&root, token)).await
}

/// Merge the fetched remote branch; conflicts are committed into the notes as
/// labeled markers (see [`merge`]). The repo is never left mid-merge.
#[tauri::command]
pub async fn git_merge_remote(
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<MergeOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || merge::merge_remote(&root)).await
}

/// Push the current branch to `origin`; rejections come back as data so the
/// sync engine can branch on them.
#[tauri::command]
pub async fn git_push(
    token: Option<String>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<PushOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || remote::push(&root, token)).await
}
