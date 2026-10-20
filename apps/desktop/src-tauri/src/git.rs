//! The git backup/sync commands: thin Tauri wrappers over [`reflect_git`].
//!
//! All operations run on blocking threads (network fetches/pushes take
//! seconds) and are **generation-gated** like file writes: every command takes
//! the `generation` the frontend received when its graph was opened and
//! resolves the root through `crate::fs::root_for_generation`, which fails
//! when the active graph's generation has since moved. A stale command errors
//! loudly instead of acting on the new graph. The one exception is
//! `git_clone`, which runs before any graph is open.

use std::path::{Path, PathBuf};

use tauri::State;

use reflect_git::{
    CommitOutcome, GitCredential, GitStatus, MAX_FILE_BYTES, PullOutcome, PushOutcome, RemoteDelta,
    RemoteTip,
};

use crate::blocking::run_blocking;
use crate::error::AppResult;
use crate::fs::GraphState;

/// Run a git operation on a blocking thread, retrying once after clearing a
/// stale `.lock` file.
async fn run_git<T, F>(root: PathBuf, operation: F) -> AppResult<T>
where
    T: Send + 'static,
    F: Fn(&Path) -> AppResult<T> + Send + 'static,
{
    run_blocking(move || reflect_git::run_with_lock_retry(&root, &operation)).await
}

/// Snapshot the backup repository (cheap, no network).
#[tauri::command]
pub async fn git_status(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || reflect_git::status(&root)).await
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
        crate::fs::with_graph_lock(root, || {
            reflect_git::setup(root, remote_url.clone(), branch.clone())
        })
    })
    .await
}

/// Stop backing this graph up (drop `origin`; repo, history, and the
/// machine-level credential all stay).
#[tauri::command]
pub async fn git_disconnect(generation: u64, state: State<'_, GraphState>) -> AppResult<GitStatus> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_git(root, |root| {
        crate::fs::with_graph_lock(root, || reflect_git::disconnect(root))
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
    run_blocking(move || reflect_git::clone(&url, Path::new(&path), credential)).await
}

/// Commit every pending change (no-op when clean).
#[tauri::command]
pub async fn git_commit_all(
    message: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<CommitOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    let started = std::time::Instant::now();
    let outcome = run_git(root, move |root| {
        reflect_git::commit_all(root, &message, MAX_FILE_BYTES)
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
    run_git(root, move |root| {
        reflect_git::fetch(root, credential.clone())
    })
    .await
}

/// Read the remote tip of the current branch without fetching. `url` probes
/// a remote other than `origin`.
#[tauri::command]
pub async fn git_remote_head(
    url: Option<String>,
    credential: Option<GitCredential>,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<RemoteTip> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    run_blocking(move || reflect_git::remote_head(&root, url.as_deref(), credential)).await
}

/// Commit local changes, then merge the fetched remote branch.
#[tauri::command]
pub async fn git_pull(
    message: String,
    generation: u64,
    state: State<'_, GraphState>,
) -> AppResult<PullOutcome> {
    let root = crate::fs::root_for_generation(&state, generation)?;
    let outcome = run_git(root, move |root| {
        reflect_git::pull_all(root, &message, MAX_FILE_BYTES)
    })
    .await;
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
    run_git(root, move |root| {
        reflect_git::push(root, credential.clone())
    })
    .await
}
