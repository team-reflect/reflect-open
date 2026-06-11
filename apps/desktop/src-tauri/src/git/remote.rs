//! Network operations: fetch and push over HTTPS with token credentials.
//!
//! Tokens arrive per call and are supplied through libgit2's credential
//! callback — they are **never** embedded in the remote URL, so they never
//! touch `.git/config` or disk.

use std::cell::RefCell;
use std::path::Path;

use git2::{Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, Repository};
use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::repo::{current_branch, open_existing};

/// Where the local branch stands relative to its last-fetched remote
/// counterpart (no network — call after `fetch`).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDelta {
    pub ahead: usize,
    pub behind: usize,
}

/// Result of a push attempt. `pushed: false` with `non_fast_forward: true` is
/// the normal two-device case (pull, merge, retry); a `rejection_message`
/// carries anything else the remote said (e.g. GitHub push protection).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
    pub pushed: bool,
    /// The remote moved past us (another device pushed first): the caller
    /// pulls, merges, and retries. Auth/network failures are `AppError`s,
    /// never this.
    pub non_fast_forward: bool,
    pub rejection_message: Option<String>,
}

/// `RemoteCallbacks` pre-wired with the token credential handler — the one
/// configuration fetch, clone, and push all share. Callers layer their own
/// callbacks (push status, sideband) on top.
fn callbacks_with_credentials<'cb>(token: Option<String>) -> RemoteCallbacks<'cb> {
    let mut callbacks = RemoteCallbacks::new();
    callbacks.credentials(move |_url, _username, allowed| {
        if !allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::from_str(
                "the remote requires an unsupported credential type (only HTTPS token auth is supported)",
            ));
        }
        match &token {
            Some(token) => Cred::userpass_plaintext("x-access-token", token),
            None => Err(git2::Error::from_str(
                "the remote requires authentication but no token is connected",
            )),
        }
    });
    callbacks
}

fn origin(repo: &Repository) -> AppResult<git2::Remote<'_>> {
    repo.find_remote("origin")
        .map_err(|_| AppError::not_found("no backup remote is configured for this graph"))
}

/// Fetch `origin` (configured refspecs) and report ahead/behind for the
/// current branch.
pub(super) fn fetch(root: &Path, token: Option<String>) -> AppResult<RemoteDelta> {
    let repo = open_existing(root)?;
    {
        let mut remote = origin(&repo)?;
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(callbacks_with_credentials(token));
        remote.fetch(&[] as &[&str], Some(&mut opts), None)?;
    }
    local_delta(&repo)
}

/// Ahead/behind vs the already-fetched `origin/<branch>`; tolerates the unborn
/// and never-pushed cases (a fresh backup repo has no remote branch yet).
pub(super) fn local_delta(repo: &Repository) -> AppResult<RemoteDelta> {
    let branch = current_branch(repo)?;
    let local = repo.refname_to_id(&format!("refs/heads/{branch}")).ok();
    let remote = repo
        .refname_to_id(&format!("refs/remotes/origin/{branch}"))
        .ok();
    match (local, remote) {
        (Some(local), Some(remote)) => {
            let (ahead, behind) = repo.graph_ahead_behind(local, remote)?;
            Ok(RemoteDelta { ahead, behind })
        }
        (Some(local), None) => Ok(RemoteDelta {
            ahead: count_commits(repo, local)?,
            behind: 0,
        }),
        (None, Some(remote)) => Ok(RemoteDelta {
            ahead: 0,
            behind: count_commits(repo, remote)?,
        }),
        (None, None) => Ok(RemoteDelta {
            ahead: 0,
            behind: 0,
        }),
    }
}

fn count_commits(repo: &Repository, from: git2::Oid) -> AppResult<usize> {
    let mut walk = repo.revwalk()?;
    walk.push(from)?;
    Ok(walk.filter_map(Result::ok).count())
}

/// Clone `url` into `target` (restore on a fresh machine). git2 refuses a
/// non-empty existing directory, which is exactly the safety we want — a
/// restore must never write into a folder that already has content.
pub(super) fn clone(url: &str, target: &Path, token: Option<String>) -> AppResult<()> {
    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks_with_credentials(token));
    git2::build::RepoBuilder::new()
        .fetch_options(fetch_options)
        .clone(url, target)?;
    Ok(())
}

/// Push the current branch to `origin`. Rejections come back as data, not
/// errors — the sync engine branches on them (non-fast-forward → pull/merge/
/// retry; anything else → surface the remote's message).
pub(super) fn push(root: &Path, token: Option<String>) -> AppResult<PushOutcome> {
    let repo = open_existing(root)?;
    let branch = current_branch(&repo)?;
    let mut remote = origin(&repo)?;

    let rejection: RefCell<Option<String>> = RefCell::new(None);
    let sideband: RefCell<String> = RefCell::new(String::new());
    let result = {
        let mut callbacks = callbacks_with_credentials(token);
        callbacks.push_update_reference(|_refname, status| {
            if let Some(message) = status {
                *rejection.borrow_mut() = Some(message.to_string());
            }
            Ok(())
        });
        // GitHub explains pre-receive declines (push protection, size limits)
        // on the sideband channel; capture it so rejections are actionable.
        callbacks.sideband_progress(|data| {
            sideband
                .borrow_mut()
                .push_str(&String::from_utf8_lossy(data));
            true
        });
        let mut opts = PushOptions::new();
        opts.remote_callbacks(callbacks);
        let refspec = format!("refs/heads/{branch}:refs/heads/{branch}");
        remote.push(&[refspec.as_str()], Some(&mut opts))
    };

    let rejection = rejection.into_inner();
    let sideband = sideband.into_inner();
    match result {
        Ok(()) => match rejection {
            None => Ok(PushOutcome {
                pushed: true,
                non_fast_forward: false,
                rejection_message: None,
            }),
            Some(message) => Ok(classify_rejection(message, &sideband)),
        },
        Err(err) if err.code() == git2::ErrorCode::NotFastForward => Ok(PushOutcome {
            pushed: false,
            non_fast_forward: true,
            rejection_message: Some(err.message().to_string()),
        }),
        Err(err) => {
            if let Some(message) = rejection {
                return Ok(classify_rejection(message, &sideband));
            }
            Err(AppError::from(err))
        }
    }
}

fn classify_rejection(message: String, sideband: &str) -> PushOutcome {
    let lowered = message.to_lowercase();
    let non_fast_forward = lowered.contains("non-fast-forward")
        || lowered.contains("fetch first")
        || lowered.contains("cannot lock ref");
    let detail = sideband.trim();
    let full = if detail.is_empty() {
        message
    } else {
        format!("{message}\n{detail}")
    };
    PushOutcome {
        pushed: false,
        non_fast_forward,
        rejection_message: Some(full),
    }
}
