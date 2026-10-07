//! Network operations: fetch and push over HTTPS or SSH.
//!
//! Credentials are supplied through libgit2's credential callback — they are
//! **never** embedded in the remote URL, so they never touch `.git/config` or
//! disk. A per-call [`GitCredential`] authenticates over HTTPS; without one,
//! credentials resolve locally — the SSH agent for ssh remotes (Plan 16 V1).

use std::cell::RefCell;
use std::path::Path;

use git2::{Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, Repository};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

use super::repo::{current_branch, open_existing};

/// An HTTPS sign-in supplied per call. Which username and secret a host
/// wants is `@reflect/core`'s business (GitHub: `x-access-token` plus the
/// managed token); this layer only presents it, once, as basic auth.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCredential {
    pub username: String,
    pub secret: String,
}

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

/// Pick a credential for one callback invocation.
///
/// With a [`GitCredential`] it is HTTPS basic auth, offered exactly once:
/// libgit2 re-invokes the callback after a rejection, and re-offering the
/// same sign-in only ends in "too many authentication replays" instead of
/// an error that names the problem. It is never offered for any other
/// credential type, so a sign-in cannot leak to a transport we didn't
/// intend. Without one (generic remotes, Plan 16 V1) the chain is: answer
/// a bare username probe, then offer the SSH agent, again once. Generic
/// HTTPS fails fast until per-host sign-ins exist. Errors carry
/// `ErrorCode::Auth` so they classify as `AppError::Auth` (surfaced as
/// needs-attention, not retried blindly).
fn resolve_credential(
    credential: Option<&GitCredential>,
    username_from_url: Option<&str>,
    allowed: CredentialType,
    tried: &mut Tried,
) -> Result<Cred, git2::Error> {
    use git2::{ErrorClass, ErrorCode};
    if let Some(credential) = credential {
        if !allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Callback,
                "the remote requires an unsupported credential type (a stored sign-in is HTTPS-only)",
            ));
        }
        if tried.credential {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Http,
                "the host rejected the stored sign-in",
            ));
        }
        tried.credential = true;
        return Cred::userpass_plaintext(&credential.username, &credential.secret);
    }
    // SSH asks in two rounds: first the username alone (`ssh://host/…` URLs
    // that don't carry one), then a key for it.
    if allowed.contains(CredentialType::USERNAME) {
        return Cred::username(username_from_url.unwrap_or("git"));
    }
    if allowed.contains(CredentialType::SSH_KEY) {
        if tried.ssh_agent {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Ssh,
                "the SSH agent offered no key this host accepts — `ssh-add` the right key, then check `ssh -T git@<host>` works",
            ));
        }
        tried.ssh_agent = true;
        return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
    }
    if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
        return Err(git2::Error::new(
            ErrorCode::Auth,
            ErrorClass::Http,
            "HTTPS sign-in is only supported for github.com — use an SSH remote URL (git@host:owner/repo.git) for other hosts",
        ));
    }
    Err(git2::Error::new(
        ErrorCode::Auth,
        ErrorClass::Callback,
        "the remote requires an unsupported credential type",
    ))
}

/// Which answers one connection has already offered (each exactly once).
#[derive(Default)]
struct Tried {
    credential: bool,
    ssh_agent: bool,
}

/// `RemoteCallbacks` pre-wired with the credential chain — the one
/// configuration fetch, clone, and push all share. Callers layer their own
/// callbacks (push status, sideband) on top.
fn callbacks_with_credentials<'cb>(credential: Option<GitCredential>) -> RemoteCallbacks<'cb> {
    let mut callbacks = RemoteCallbacks::new();
    let mut tried = Tried::default();
    callbacks.credentials(move |_url, username_from_url, allowed| {
        resolve_credential(credential.as_ref(), username_from_url, allowed, &mut tried)
    });
    callbacks
}

fn origin(repo: &Repository) -> AppResult<git2::Remote<'_>> {
    repo.find_remote("origin")
        .map_err(|_| AppError::not_found("no backup remote is configured for this graph"))
}

/// Fetch `origin` (configured refspecs) and report ahead/behind for the
/// current branch.
pub(super) fn fetch(root: &Path, credential: Option<GitCredential>) -> AppResult<RemoteDelta> {
    let repo = open_existing(root)?;
    {
        let mut remote = origin(&repo)?;
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(callbacks_with_credentials(credential));
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
pub(super) fn clone(url: &str, target: &Path, credential: Option<GitCredential>) -> AppResult<()> {
    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks_with_credentials(credential));
    git2::build::RepoBuilder::new()
        .fetch_options(fetch_options)
        .clone(url, target)?;
    Ok(())
}

/// Push the current branch to `origin`. Rejections come back as data, not
/// errors — the sync engine branches on them (non-fast-forward → pull/merge/
/// retry; anything else → surface the remote's message).
/// Where `origin` says its branch is, next to where the last fetch left it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteTip {
    /// The remote branch's commit, `None` while the branch is unborn there.
    pub remote_oid: Option<String>,
    /// `refs/remotes/origin/<branch>` as the last fetch left it.
    pub tracking_oid: Option<String>,
}

/// Ask `origin` for its branch tip in one ref-advertisement round trip,
/// without downloading objects or touching the working tree. A tip that
/// differs from the tracking ref means the remote moved since the last fetch.
pub(super) fn remote_head(root: &Path, credential: Option<GitCredential>) -> AppResult<RemoteTip> {
    let repo = open_existing(root)?;
    let branch = current_branch(&repo)?;
    let mut remote = origin(&repo)?;
    let refname = format!("refs/heads/{branch}");
    remote.connect_auth(
        git2::Direction::Fetch,
        Some(callbacks_with_credentials(credential)),
        None,
    )?;
    let remote_oid = remote
        .list()?
        .iter()
        .find(|head| head.name() == refname)
        .map(|head| head.oid().to_string());
    remote.disconnect()?;
    let tracking_oid = repo
        .refname_to_id(&format!("refs/remotes/origin/{branch}"))
        .ok()
        .map(|oid| oid.to_string());
    Ok(RemoteTip {
        remote_oid,
        tracking_oid,
    })
}

pub(super) fn push(root: &Path, credential: Option<GitCredential>) -> AppResult<PushOutcome> {
    let repo = open_existing(root)?;
    let branch = current_branch(&repo)?;
    let mut remote = origin(&repo)?;

    let rejection: RefCell<Option<String>> = RefCell::new(None);
    let sideband: RefCell<String> = RefCell::new(String::new());
    let result = {
        let mut callbacks = callbacks_with_credentials(credential);
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

#[cfg(test)]
mod credential_tests {
    use git2::{Cred, CredentialType, ErrorCode};

    use super::{resolve_credential, GitCredential, Tried};

    fn github() -> GitCredential {
        GitCredential {
            username: "x-access-token".to_string(),
            secret: "ghs_token".to_string(),
        }
    }

    // `Cred` implements no `Debug`, so unwrap/expect can't print it.
    fn expect_ok(result: Result<Cred, git2::Error>) {
        if let Err(err) = result {
            panic!("expected a credential: {err}");
        }
    }

    fn expect_err(result: Result<Cred, git2::Error>) -> git2::Error {
        match result {
            Ok(_) => panic!("expected an error, got a credential"),
            Err(err) => err,
        }
    }

    #[test]
    fn credential_authenticates_https() {
        let mut tried = Tried::default();
        expect_ok(resolve_credential(
            Some(&github()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
        ));
        assert!(tried.credential);
    }

    #[test]
    fn credential_is_offered_once_then_errors_actionably() {
        // libgit2 re-invokes the callback after a rejection; replaying the
        // same sign-in fifteen times ends in a generic replay error.
        let mut tried = Tried::default();
        expect_ok(resolve_credential(
            Some(&github()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
        ));
        let err = expect_err(resolve_credential(
            Some(&github()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("rejected"), "{err}");
    }

    #[test]
    fn credential_is_never_offered_to_non_https_transports() {
        // A github.com remote rewired to ssh, or any future transport, must
        // not receive the sign-in as some other credential shape.
        let mut tried = Tried::default();
        let err = expect_err(resolve_credential(
            Some(&github()),
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("HTTPS-only"), "{err}");
        assert!(
            !tried.ssh_agent,
            "the agent must not be consulted on the sign-in path"
        );
    }

    #[test]
    fn ssh_username_probe_is_answered() {
        let mut tried = Tried::default();
        expect_ok(resolve_credential(
            None,
            None,
            CredentialType::USERNAME,
            &mut tried,
        ));
        assert!(!tried.ssh_agent);
    }

    #[test]
    fn ssh_agent_is_offered_once_then_errors_actionably() {
        let mut tried = Tried::default();
        expect_ok(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
        ));
        assert!(tried.ssh_agent);

        let err = expect_err(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("ssh-add"), "{err}");
    }

    #[test]
    fn generic_https_fails_fast_with_the_ssh_suggestion() {
        let mut tried = Tried::default();
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("SSH remote URL"), "{err}");
    }

    #[test]
    fn unsupported_credential_types_error_with_auth() {
        let mut tried = Tried::default();
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::SSH_INTERACTIVE,
            &mut tried,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
    }
}
