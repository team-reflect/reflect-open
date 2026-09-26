//! Network operations: fetch and push over HTTPS or SSH.
//!
//! Credentials are supplied through libgit2's credential callback — they are
//! **never** embedded in the remote URL, so they never touch `.git/config` or
//! disk. A per-call [`BasicCredential`] authenticates over HTTPS — the
//! managed GitHub sign-in or a per-host entry from the user's keychain,
//! whichever core picked; without one, credentials resolve locally through
//! the SSH agent (Plan 16 V1).

use std::cell::RefCell;
use std::path::Path;

use git2::{
    Cred, CredentialType, FetchOptions, PushOptions, RemoteCallbacks, RemoteRedirect, Repository,
};
use serde::{Deserialize, Serialize};

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

/// An HTTPS basic-auth credential for one fetch/push/clone.
///
/// Which credential belongs to which remote is `@reflect/core`'s decision —
/// this module only knows how to present one, and deliberately knows nothing
/// about GitHub. The managed GitHub sign-in arrives as username
/// `x-access-token`; a generic remote as the user's own username.
// No `Debug`: `secret` is the user's token, and a derived impl would print it.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BasicCredential {
    pub username: String,
    pub secret: String,
}

/// Pick a credential for one callback invocation.
///
/// A supplied credential is basic auth, offered only when libgit2 asks for a
/// username and password — never as an SSH key or any other shape. Which
/// remotes receive one is core's decision, not this function's: an SSH server
/// that allows password auth would also ask for a username and password, so
/// the guarantee that a credential only reaches HTTP(S) hosts lives in core's
/// routing. Whatever is offered — that credential, or the SSH agent when there
/// is none — is offered **once**: libgit2 re-invokes this callback after a
/// rejection — over HTTP fifteen challenges in total, `GIT_HTTP_REPLAY_MAX`,
/// before failing with "too many redirects or authentication replays" — and
/// re-offering the same thing only buys the same rejection with a less useful
/// message at the end.
/// It asks exactly once for a credential the host accepts, including across a
/// push's two requests, which reuse the connection's credential — so a second
/// ask is always a rejection, and answering it with an actionable error costs
/// nothing on the success path. `credential_loop_tests` covers both. Errors
/// carry `ErrorCode::Auth` so they classify as `AppError::Auth` (surfaced as
/// needs-attention, not retried blindly).
fn resolve_credential(
    credential: Option<&BasicCredential>,
    username_from_url: Option<&str>,
    allowed: CredentialType,
    credential_offered: &mut bool,
) -> Result<Cred, git2::Error> {
    use git2::{ErrorClass, ErrorCode};
    if let Some(credential) = credential {
        if !allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Callback,
                "the remote requires an unsupported credential type (token sign-in is HTTPS-only)",
            ));
        }
        if *credential_offered {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Http,
                "your git host rejected the username and access token — check they are right, and that the token still has write access to the repository",
            ));
        }
        *credential_offered = true;
        return Cred::userpass_plaintext(&credential.username, &credential.secret);
    }
    // SSH asks in two rounds: first the username alone (`ssh://host/…` URLs
    // that don't carry one), then a key for it. The probe is not an offer.
    if allowed.contains(CredentialType::USERNAME) {
        return Cred::username(username_from_url.unwrap_or("git"));
    }
    if allowed.contains(CredentialType::SSH_KEY) {
        if *credential_offered {
            return Err(git2::Error::new(
                ErrorCode::Auth,
                ErrorClass::Ssh,
                "the SSH agent offered no key this host accepts — `ssh-add` the right key, then check `ssh -T git@<host>` works",
            ));
        }
        *credential_offered = true;
        return Cred::ssh_key_from_agent(username_from_url.unwrap_or("git"));
    }
    if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
        return Err(git2::Error::new(
            ErrorCode::Auth,
            ErrorClass::Http,
            "no username and access token are stored for this host — add them, or use an SSH remote URL (git@host:owner/repo.git)",
        ));
    }
    Err(git2::Error::new(
        ErrorCode::Auth,
        ErrorClass::Callback,
        "the remote requires an unsupported credential type",
    ))
}

/// `RemoteCallbacks` pre-wired with the credential chain — the one
/// configuration fetch, clone, and push all share. Callers layer their own
/// callbacks (push status, sideband) on top, and each also sets
/// `RemoteRedirect::None`: libgit2's default follows an off-site redirect on
/// the first request and then asks this callback for credentials for the new
/// host, which would hand it a credential stored for another. Same-host
/// redirects, including an upgrade to https, are still followed — and libgit2
/// compares host names only, so a redirect to another port on the same host is
/// followed too, though core keys credentials by port.
fn callbacks_with_credentials<'cb>(credential: Option<BasicCredential>) -> RemoteCallbacks<'cb> {
    let mut callbacks = RemoteCallbacks::new();
    let mut credential_offered = false;
    callbacks.credentials(move |_url, username_from_url, allowed| {
        resolve_credential(
            credential.as_ref(),
            username_from_url,
            allowed,
            &mut credential_offered,
        )
    });
    callbacks
}

fn origin(repo: &Repository) -> AppResult<git2::Remote<'_>> {
    repo.find_remote("origin")
        .map_err(|_| AppError::not_found("no backup remote is configured for this graph"))
}

/// Fetch `origin` (configured refspecs) and report ahead/behind for the
/// current branch.
pub(super) fn fetch(root: &Path, credential: Option<BasicCredential>) -> AppResult<RemoteDelta> {
    let repo = open_existing(root)?;
    {
        let mut remote = origin(&repo)?;
        let mut opts = FetchOptions::new();
        opts.remote_callbacks(callbacks_with_credentials(credential));
        opts.follow_redirects(RemoteRedirect::None);
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
pub(super) fn clone(
    url: &str,
    target: &Path,
    credential: Option<BasicCredential>,
) -> AppResult<()> {
    let mut fetch_options = FetchOptions::new();
    fetch_options.remote_callbacks(callbacks_with_credentials(credential));
    fetch_options.follow_redirects(RemoteRedirect::None);
    git2::build::RepoBuilder::new()
        .fetch_options(fetch_options)
        .clone(url, target)?;
    Ok(())
}

/// Push the current branch to `origin`. Rejections come back as data, not
/// errors — the sync engine branches on them (non-fast-forward → pull/merge/
/// retry; anything else → surface the remote's message).
pub(super) fn push(root: &Path, credential: Option<BasicCredential>) -> AppResult<PushOutcome> {
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
        opts.follow_redirects(RemoteRedirect::None);
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

    use super::{resolve_credential, BasicCredential};

    /// The managed GitHub sign-in, as core presents it.
    fn github() -> BasicCredential {
        BasicCredential {
            username: "x-access-token".into(),
            secret: "ghs_token".into(),
        }
    }

    /// A generic remote's keychain entry.
    fn host() -> BasicCredential {
        BasicCredential {
            username: "alex".into(),
            secret: "pat".into(),
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
    fn token_authenticates_https() {
        let mut offered = false;
        expect_ok(resolve_credential(
            Some(&github()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut offered,
        ));
    }

    #[test]
    fn token_is_never_offered_to_non_https_transports() {
        // A github.com remote rewired to ssh, or any future transport, must
        // not receive the managed token as some other credential shape.
        let mut offered = false;
        let err = expect_err(resolve_credential(
            Some(&github()),
            Some("git"),
            CredentialType::SSH_KEY,
            &mut offered,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("HTTPS-only"), "{err}");
        assert!(
            !offered,
            "nothing may be offered to a transport the token cannot use"
        );
    }

    #[test]
    fn ssh_username_probe_is_answered() {
        let mut offered = false;
        expect_ok(resolve_credential(
            None,
            None,
            CredentialType::USERNAME,
            &mut offered,
        ));
        assert!(!offered, "a username probe is not a credential");
    }

    #[test]
    fn ssh_agent_is_offered_once_then_errors_actionably() {
        // libgit2 re-invokes the callback after a rejected credential; the
        // second ask must become the actionable error, not the same offer.
        let mut offered = false;
        expect_ok(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut offered,
        ));
        assert!(offered);

        let err = expect_err(resolve_credential(
            None,
            Some("git"),
            CredentialType::SSH_KEY,
            &mut offered,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("ssh-add"), "{err}");
    }

    #[test]
    fn generic_https_fails_fast_with_the_ssh_suggestion() {
        // Plan 16 V1: no credential-helper resolution yet — an honest error
        // beats a half-try that dies somewhere less explicable.
        let mut offered = false;
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut offered,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(
            err.message().contains("no username and access token"),
            "{err}"
        );
    }

    #[test]
    fn host_credential_authenticates_https() {
        let mut offered = false;
        expect_ok(resolve_credential(
            Some(&host()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut offered,
        ));
        assert!(offered);
    }

    #[test]
    fn the_github_token_is_guarded_too() {
        // libgit2 asks once for an accepted credential, so a second ask means
        // GitHub rejected this token. The managed sign-in gets the same guard
        // as any other credential.
        let mut offered = false;
        expect_ok(resolve_credential(
            Some(&github()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut offered,
        ));
        let err = expect_err(resolve_credential(
            Some(&github()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut offered,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
    }

    #[test]
    fn host_credential_is_offered_once_then_errors_actionably() {
        // Same reasoning as the SSH agent: a second ask is a rejection, and
        // the user should hear that rather than libgit2's replay-cap message.
        let mut offered = false;
        expect_ok(resolve_credential(
            Some(&host()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut offered,
        ));
        let err = expect_err(resolve_credential(
            Some(&host()),
            None,
            CredentialType::USER_PASS_PLAINTEXT,
            &mut offered,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("rejected the username"), "{err}");
    }

    #[test]
    fn host_credential_is_never_offered_to_non_https_transports() {
        // A keychain entry for a web host must not be handed to an SSH
        // transport either.
        let mut offered = false;
        let err = expect_err(resolve_credential(
            Some(&host()),
            Some("git"),
            CredentialType::SSH_KEY,
            &mut offered,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
        assert!(err.message().contains("HTTPS-only"), "{err}");
        assert!(!offered);
    }

    #[test]
    fn unsupported_credential_types_error_with_auth() {
        let mut offered = false;
        let err = expect_err(resolve_credential(
            None,
            None,
            CredentialType::SSH_INTERACTIVE,
            &mut offered,
        ));
        assert_eq!(err.code(), ErrorCode::Auth);
    }
}

#[cfg(test)]
mod credential_loop_tests {
    //! The guard exists because of how libgit2 behaves, not how we do, so
    //! testing it needs a real HTTP exchange. The other git tests use path
    //! remotes, which never invoke the credential callback at all.
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    use base64::Engine;

    use super::{clone, fetch, BasicCredential};

    const USERNAME: &str = "alex";
    const SECRET: &str = "pat";

    fn credential() -> BasicCredential {
        BasicCredential {
            username: USERNAME.into(),
            secret: SECRET.into(),
        }
    }

    /// pkt-line framing: four hex digits of total length, then the payload.
    fn pkt(payload: &str) -> String {
        format!("{:04x}{payload}", payload.len() + 4)
    }

    /// The smart-HTTP ref advertisement for an empty repository — enough for
    /// libgit2 to consider a fetch or clone complete.
    fn empty_advertisement() -> String {
        format!(
            "{}0000{}0000",
            pkt("# service=git-upload-pack\n"),
            pkt("0000000000000000000000000000000000000000 capabilities^{}\0side-band-64k\n"),
        )
    }

    /// Read one request's headers, through the blank line, so a request split
    /// across TCP reads is never judged from a partial chunk.
    fn read_headers(stream: &mut TcpStream) -> Option<String> {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 1024];
        while !bytes.ends_with(b"\r\n\r\n") {
            match stream.read(&mut chunk) {
                Ok(0) | Err(_) => return None,
                Ok(read) => bytes.extend_from_slice(&chunk[..read]),
            }
        }
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }

    /// Whether the request carries exactly the credential under test —
    /// decoded, not merely present, so a regression in how it is encoded
    /// cannot slip through.
    fn presents_credential(headers: &str) -> bool {
        headers
            .lines()
            .find_map(|line| line.strip_prefix("Authorization: Basic "))
            .and_then(|encoded| {
                base64::engine::general_purpose::STANDARD
                    .decode(encoded.trim())
                    .ok()
            })
            .is_some_and(|decoded| decoded == format!("{USERNAME}:{SECRET}").as_bytes())
    }

    /// Serve one connection until it closes: challenge any request that does
    /// not present the credential; accept or reject one that does, per
    /// `accepts`. Keep-alive matters: libgit2 retries a rejected credential on
    /// the same connection, so hanging up after one response would look like
    /// a network fault rather than a rejection.
    fn serve(mut stream: TcpStream, accepts: bool, challenges: Arc<AtomicUsize>) {
        while let Some(headers) = read_headers(&mut stream) {
            let response = if accepts && presents_credential(&headers) {
                let body = empty_advertisement();
                format!(
                    "HTTP/1.1 200 OK\r\n\
                     Content-Type: application/x-git-upload-pack-advertisement\r\n\
                     Content-Length: {}\r\n\r\n{body}",
                    body.len()
                )
            } else {
                challenges.fetch_add(1, Ordering::SeqCst);
                "HTTP/1.1 401 Unauthorized\r\n\
                 WWW-Authenticate: Basic realm=\"test\"\r\n\
                 Content-Length: 0\r\n\r\n"
                    .to_string()
            };
            if stream.write_all(response.as_bytes()).is_err() || stream.flush().is_err() {
                return;
            }
        }
    }

    /// A loopback git host, one thread per connection so a second connection
    /// never waits behind an idle first one. Returns its URL and the count of
    /// challenges it issued.
    fn spawn_server(accepts: bool) -> (String, Arc<AtomicUsize>) {
        spawn_server_on("127.0.0.1", accepts)
    }

    /// As [`spawn_server`], reached under `host` — so two loopback servers can
    /// differ by host name, which is what libgit2's off-site test compares.
    fn spawn_server_on(host: &str, accepts: bool) -> (String, Arc<AtomicUsize>) {
        let listener = TcpListener::bind((host, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let challenges = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&challenges);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let counter = Arc::clone(&counter);
                std::thread::spawn(move || serve(stream, accepts, counter));
            }
        });
        (format!("http://{host}:{port}/probe.git"), challenges)
    }

    /// A loopback host that redirects every request to `target`.
    fn spawn_redirecting_server(target: &str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let location = format!("{target}/info/refs?service=git-upload-pack");
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let location = location.clone();
                std::thread::spawn(move || {
                    while read_headers(&mut stream).is_some() {
                        let response = format!(
                            "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\n\r\n"
                        );
                        if stream.write_all(response.as_bytes()).is_err() {
                            return;
                        }
                    }
                });
            }
        });
        format!("http://127.0.0.1:{port}/probe.git")
    }

    /// An unborn repository whose only job is to carry `origin`; `fetch`
    /// tolerates the unborn HEAD through `local_delta`, so no commit is needed.
    fn repo_with_origin(url: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let repo = git2::Repository::init(dir.path()).unwrap();
        repo.remote("origin", url).unwrap();
        dir
    }

    #[test]
    fn a_rejected_credential_is_offered_once_then_fails_actionably() {
        let (url, challenges) = spawn_server(false);
        let dir = repo_with_origin(&url);

        let error = fetch(dir.path(), Some(credential()))
            .expect_err("a rejected credential must not succeed");

        // Two challenges: answered once, rejected, then refused to answer
        // again. Without the guard libgit2 issues fifteen (GIT_HTTP_REPLAY_MAX)
        // and fails with its own generic message instead — measured.
        assert_eq!(challenges.load(Ordering::SeqCst), 2);
        assert!(
            format!("{error:?}").contains("rejected the username"),
            "{error:?}"
        );
    }

    #[test]
    fn an_accepted_credential_is_asked_for_once_on_fetch() {
        let (url, challenges) = spawn_server(true);
        let dir = repo_with_origin(&url);

        // Self-proving: had libgit2 asked a second time on the success path,
        // the guard would have fired and this would be Err.
        fetch(dir.path(), Some(credential()))
            .expect("an accepted credential must get through the guard");
        assert_eq!(challenges.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn an_accepted_credential_is_asked_for_once_on_clone() {
        // Clone is the restore-on-a-fresh-machine path and shares the guard,
        // so it needs the same proof.
        let (url, challenges) = spawn_server(true);
        let dir = tempfile::tempdir().unwrap();

        clone(&url, &dir.path().join("restored"), Some(credential()))
            .expect("an accepted credential must get through the guard on clone");
        assert_eq!(challenges.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn a_credential_does_not_follow_a_redirect_to_another_host() {
        let (target, target_challenges) = spawn_server_on("localhost", true);
        let url = spawn_redirecting_server(&target);
        let dir = repo_with_origin(&url);

        let error = fetch(dir.path(), Some(credential()))
            .expect_err("an off-site redirect must not be followed");

        // Had the redirect been followed, the other host would have challenged
        // and been answered with the credential stored for this one.
        assert_eq!(target_challenges.load(Ordering::SeqCst), 0);
        assert!(
            format!("{error:?}").contains("cannot redirect"),
            "{error:?}"
        );
    }
}
