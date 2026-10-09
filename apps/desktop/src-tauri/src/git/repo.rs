//! Repository plumbing: open/init/adopt, branch + signature resolution, and
//! graph `.gitignore` defaults.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use git2::{Repository, RepositoryInitOptions, Signature};

use crate::error::{AppError, AppResult};
use crate::graph_gitignore;

/// The branch Reflect creates for new backup repos. Adopted repos keep
/// whatever branch their HEAD already points at — nothing below hardcodes it.
const DEFAULT_BRANCH: &str = "main";

/// Open the graph's repository, initializing one (HEAD → `main`) when absent.
/// A graph that is already a Git repo is adopted as-is, never nested.
pub(super) fn open_or_init(root: &Path) -> AppResult<Repository> {
    if root.join(".git").exists() {
        return open_existing(root);
    }
    let mut opts = RepositoryInitOptions::new();
    opts.initial_head(DEFAULT_BRANCH);
    let repo = Repository::init_opts(root, &opts)?;
    // A repo created inside a file-sync folder (iCloud Drive) must not sync
    // through it — two devices' object stores merging file-by-file corrupts
    // the repository (Plan 21). Pre-existing repos are marked at graph open.
    crate::fs::mark_dir_local_only(&root.join(".git"));
    Ok(repo)
}

/// A lock file dated further than this from now was left by a process that
/// died holding it: libgit2 holds a lock for one operation, well under a
/// second.
const STALE_LOCK_AGE: Duration = Duration::from_secs(10 * 60);

/// Open the graph's repository; errors if backup was never set up.
pub(super) fn open_existing(root: &Path) -> AppResult<Repository> {
    if !root.join(".git").exists() {
        return Err(AppError::not_found("backup is not set up for this graph"));
    }
    let repo = Repository::open(root)?;
    // Opening takes no lock, so the sweep still runs before any write. The
    // directories are libgit2's own answer: a linked worktree keeps its
    // index beside the main repository's refs.
    sweep_stale_locks(repo.path());
    if repo.commondir() != repo.path() {
        sweep_stale_locks(repo.commondir());
    }
    Ok(repo)
}

/// Remove the lock files a killed process left behind: every `*.lock`
/// directly in the git directory (`index.lock`, `HEAD.lock`,
/// `FETCH_HEAD.lock`, `MERGE_HEAD.lock`, `config.lock`, ...) and under
/// `refs/`. libgit2 refuses to write past them, which would fail every later
/// cycle until a manual repair.
///
/// Only a lock dated more than [`STALE_LOCK_AGE`] from now goes, in either
/// direction: a recent one may belong to a `git` the user is running, and
/// one dated slightly ahead was created while this sweep ran. A date far in
/// the future (a clock correction, a restore from a backup) is no live lock
/// either. Best effort: a lock that stays fails the operation as it always
/// did.
fn sweep_stale_locks(git_dir: &Path) {
    let mut locks = Vec::new();
    collect_locks(git_dir, false, &mut locks);
    collect_locks(&git_dir.join("refs"), true, &mut locks);
    for path in locks {
        let Ok(modified) = path.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        let now = SystemTime::now();
        let distance = now
            .duration_since(modified)
            .or_else(|_| modified.duration_since(now))
            .unwrap_or_default();
        if distance <= STALE_LOCK_AGE {
            tracing::debug!(path = %path.display(), "keeping a recent lock file");
            continue;
        }
        match std::fs::remove_file(&path) {
            Ok(()) => tracing::warn!(path = %path.display(), "removed a stale lock file"),
            Err(err) => {
                tracing::warn!(path = %path.display(), %err, "failed to remove a stale lock file");
            }
        }
    }
}

/// `*.lock` files directly in `dir`, and below it when `recurse`. Only real
/// directories are read and only regular files are collected (neither check
/// follows a symlink), so a link out of the repository, at `dir` itself or
/// anywhere below, cannot steer the sweep.
fn collect_locks(dir: &Path, recurse: bool, out: &mut Vec<PathBuf>) {
    if !std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()) {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|ext| ext == "lock") {
            if entry.file_type().is_ok_and(|kind| kind.is_file()) {
                out.push(path);
            }
        } else if recurse {
            collect_locks(&path, true, out);
        }
    }
}

/// Refuse to operate on a repository mid-operation (a rebase/merge the user
/// started with the git CLI). Guessing here could destroy their state.
pub(super) fn ensure_clean_state(repo: &Repository) -> AppResult<()> {
    if repo.state() != git2::RepositoryState::Clean {
        return Err(AppError::io(format!(
            "the backup repository has a {:?} in progress; finish or abort it with git first",
            repo.state()
        )));
    }
    Ok(())
}

/// The branch HEAD points at. Works on an unborn HEAD (where `repo.head()`
/// errors); a detached HEAD is a foreign state we refuse to sync from.
pub(super) fn current_branch(repo: &Repository) -> AppResult<String> {
    let head = repo.find_reference("HEAD")?;
    match head.symbolic_target()? {
        Some(target) => Ok(target.trim_start_matches("refs/heads/").to_string()),
        None => Err(AppError::io(
            "the backup repository is on a detached HEAD; check out a branch with git first",
        )),
    }
}

/// Rename the local branch to `name` so fetch/merge/push target the branch
/// the backup repo actually uses.
///
/// HEAD's commit never changes here, so the working tree — the user's notes —
/// is never rewritten and no checkout is needed. A stale local branch already
/// carrying `name` loses the *name* (force rename), not our content: the
/// local state always wins the collision, and the remote's history integrates
/// through the next fetch + merge like any other divergence.
pub(super) fn align_branch(repo: &Repository, name: &str) -> AppResult<()> {
    let current = current_branch(repo)?;
    if current == name {
        return Ok(());
    }
    if let Ok(reference) = repo.find_reference(&format!("refs/heads/{current}")) {
        git2::Branch::wrap(reference).rename(name, true)?;
    }
    // With no current ref (unborn HEAD) there is nothing to rename — pointing
    // HEAD at the new name is enough; the first commit creates the branch.
    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(())
}

/// Commit signature: the user's git identity when configured, else a Reflect
/// fallback so backup works on machines with no global gitconfig.
pub(super) fn signature(repo: &Repository) -> AppResult<Signature<'static>> {
    if let Ok(sig) = repo.signature() {
        return Ok(sig);
    }
    Ok(Signature::now("Reflect", "backup@reflect.app")?)
}

/// Make sure graph repositories carry Reflect's safe ignore defaults. The graph
/// bootstrap already writes these, but setup may adopt an existing repository.
pub(super) fn ensure_gitignore_defaults(root: &Path) -> AppResult<()> {
    graph_gitignore::ensure_defaults(root)
}
