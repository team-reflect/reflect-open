//! The git backup/sync commands: thin wrappers over [`reflect_git`].
//!
//! All operations run on blocking threads (network fetches/pushes take
//! seconds) and are **generation-gated** like file writes: every command takes
//! the `generation` the frontend received when its graph was opened and
//! resolves the root through `reflect_graph_io::root_for_generation`, which
//! fails when the active graph's generation has since moved. A stale command
//! errors loudly instead of acting on the new graph. The one exception is
//! `git_clone`, which runs before any graph is open.

use std::path::{Path, PathBuf};

use reflect_git::{
    CommitOutcome, GitCredential, GitStatus, MAX_FILE_BYTES, PullOutcome, PushOutcome, RemoteDelta,
    RemoteTip,
};
use reflect_graph_io::{invalidate_file_catalog, root_for_generation, with_graph_lock};
use reflect_types::AppResult;

use crate::Core;

impl Core {
    /// Run a git operation on a blocking thread, retrying once after clearing
    /// a stale `.lock` file.
    async fn run_git<T, F>(&self, root: PathBuf, operation: F) -> AppResult<T>
    where
        T: Send + 'static,
        F: Fn(&Path) -> AppResult<T> + Send + 'static,
    {
        self.spawn_blocking(move || reflect_git::run_with_lock_retry(&root, &operation))
            .await
    }

    /// Command: snapshot the backup repository (cheap, no network).
    pub async fn git_status(&self, generation: u64) -> AppResult<GitStatus> {
        let root = root_for_generation(&self.graph, generation)?;
        self.spawn_blocking(move || reflect_git::status(&root))
            .await
    }

    /// Command: initialize (or adopt) the graph's repository, optionally point
    /// `origin` at `remote_url`, and align the local branch with `branch` (the
    /// remote's default — fetch/merge/push must target the branch the backup
    /// repo actually uses, e.g. an existing repo on `master` while fresh
    /// graphs init `main`). Idempotent.
    pub async fn git_setup(
        &self,
        remote_url: Option<String>,
        branch: Option<String>,
        generation: u64,
    ) -> AppResult<GitStatus> {
        let root = root_for_generation(&self.graph, generation)?;
        self.run_git(root, move |root| {
            with_graph_lock(root, || {
                reflect_git::setup(root, remote_url.clone(), branch.clone())
            })
        })
        .await
    }

    /// Command: stop backing this graph up (drop `origin`; repo, history, and
    /// the machine-level credential all stay).
    pub async fn git_disconnect(&self, generation: u64) -> AppResult<GitStatus> {
        let root = root_for_generation(&self.graph, generation)?;
        self.run_git(root, |root| {
            with_graph_lock(root, || reflect_git::disconnect(root))
        })
        .await
    }

    /// Command: clone a backup repository into `path` (restore on a fresh
    /// machine). Runs before any graph is open, so it takes an absolute
    /// destination rather than a graph-relative path; the caller opens the
    /// result as a graph afterwards.
    pub async fn git_clone(
        &self,
        url: String,
        path: String,
        credential: Option<GitCredential>,
    ) -> AppResult<()> {
        self.spawn_blocking(move || reflect_git::clone(&url, Path::new(&path), credential))
            .await
    }

    /// Command: commit every pending change (no-op when clean).
    pub async fn git_commit_all(
        &self,
        message: String,
        generation: u64,
    ) -> AppResult<CommitOutcome> {
        let root = root_for_generation(&self.graph, generation)?;
        let started = std::time::Instant::now();
        let outcome = self
            .run_git(root, move |root| {
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

    /// Command: fetch `origin` and report ahead/behind for the current branch.
    pub async fn git_fetch(
        &self,
        credential: Option<GitCredential>,
        generation: u64,
    ) -> AppResult<RemoteDelta> {
        let root = root_for_generation(&self.graph, generation)?;
        self.run_git(root, move |root| {
            reflect_git::fetch(root, credential.clone())
        })
        .await
    }

    /// Command: read the remote tip of the current branch without fetching.
    /// `url` probes a remote other than `origin`.
    pub async fn git_remote_head(
        &self,
        url: Option<String>,
        credential: Option<GitCredential>,
        generation: u64,
    ) -> AppResult<RemoteTip> {
        let root = root_for_generation(&self.graph, generation)?;
        self.spawn_blocking(move || reflect_git::remote_head(&root, url.as_deref(), credential))
            .await
    }

    /// Command: commit local changes, then merge the fetched remote branch.
    pub async fn git_pull(&self, message: String, generation: u64) -> AppResult<PullOutcome> {
        let root = root_for_generation(&self.graph, generation)?;
        let outcome = self
            .run_git(root, move |root| {
                reflect_git::pull_all(root, &message, MAX_FILE_BYTES)
            })
            .await;
        // Invalidate on both arms: a failed pull can leave the tree half written.
        let root = root_for_generation(&self.graph, generation)?;
        invalidate_file_catalog(&self.graph, &root);
        outcome
    }

    /// Command: push the current branch to `origin`; rejections come back as
    /// data so the sync engine can branch on them.
    pub async fn git_push(
        &self,
        credential: Option<GitCredential>,
        generation: u64,
    ) -> AppResult<PushOutcome> {
        let root = root_for_generation(&self.graph, generation)?;
        self.run_git(root, move |root| {
            reflect_git::push(root, credential.clone())
        })
        .await
    }
}
