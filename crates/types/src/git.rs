//! The backup repository's command arguments and results (`git_*`).

use serde::{Deserialize, Serialize};

use crate::ChangeKind;

/// Snapshot of the graph's backup repository for the UI and the sync engine.
/// Deliberately cheap — refs and config only, no working-tree scan.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
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

/// What one pull did: the commit of local changes, then the merge of the
/// fetched remote branch.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
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

/// A file whose changes were withheld because it is at or above the size
/// guardrail. An unchanged oversized file is not reported.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SkippedFile {
    /// Graph-relative path (forward-slashed) of the withheld file.
    pub path: String,
    pub size: u64,
}

/// Result of a commit attempt. `committed: false` means the tree was clean.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub committed: bool,
    pub sha: Option<String>,
    /// Commits the local branch is ahead of the last-fetched remote (no
    /// network).
    pub ahead: usize,
    pub skipped_large_files: Vec<SkippedFile>,
}

/// An HTTPS sign-in supplied per call. Which username and secret a host
/// wants is `@reflect/core`'s business (GitHub: `x-access-token` plus the
/// managed token); this layer only presents it, once, as basic auth, and
/// only to `origin`, the scheme, host and port it was stored for.
///
/// No `Debug`: a derived one would print `secret`.
#[derive(Clone, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct GitCredential {
    pub origin: String,
    pub username: String,
    pub secret: String,
}

/// Where the local branch stands relative to its last-fetched remote
/// counterpart (no network — call after `fetch`).
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RemoteDelta {
    pub ahead: usize,
    pub behind: usize,
}

/// Where the remote says the current branch is, next to the last-fetched
/// tracking ref. `remote_oid` is `None` when the remote has no such branch;
/// `default_branch` is the branch the remote's HEAD points at, `None` when
/// the remote is empty.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct RemoteTip {
    pub remote_oid: Option<String>,
    pub tracking_oid: Option<String>,
    pub default_branch: Option<String>,
}

/// Result of a push attempt. `pushed: false` with `non_fast_forward: true` is
/// the normal two-device case (pull, merge, retry); a `rejection_message`
/// carries anything else the remote said (e.g. GitHub push protection).
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub pushed: bool,
    /// Auth and network failures are `AppError`s, never this.
    pub non_fast_forward: bool,
    pub rejection_message: Option<String>,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum MergeKind {
    UpToDate,
    FastForward,
    Merged,
}

/// One working-tree file a merge/fast-forward rewrote, in the same shape as
/// the watcher's `FileChange` so the caller can reindex directly.
#[derive(Debug, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub kind: ChangeKind,
    /// Last-modified time of the written file (epoch ms; upserts only).
    pub modified_ms: Option<u64>,
}
