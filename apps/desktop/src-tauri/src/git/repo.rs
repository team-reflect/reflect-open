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

/// A `.git/*.lock` older than this was left by a process that died holding
/// it: libgit2 holds a lock for one operation, well under a second.
const STALE_LOCK_AGE: Duration = Duration::from_secs(10 * 60);

/// Open the graph's repository; errors if backup was never set up.
pub(super) fn open_existing(root: &Path) -> AppResult<Repository> {
    let git_dir = root.join(".git");
    if !git_dir.exists() {
        return Err(AppError::not_found("backup is not set up for this graph"));
    }
    sweep_stale_locks(&git_dir);
    Ok(Repository::open(root)?)
}

/// Remove the lock files a killed process left behind: every `.git/*.lock`
/// (`index.lock`, `HEAD.lock`, `FETCH_HEAD.lock`, `MERGE_HEAD.lock`,
/// `config.lock`, ...) and `refs/**/*.lock`. libgit2 refuses to write past
/// them, which would fail every later cycle until a manual repair. Only a
/// lock older than [`STALE_LOCK_AGE`] goes; a fresh one may belong to a `git`
/// the user is running right now. A lock dated in the future (clock
/// correction, restore from a backup) is not live either. Best effort: a lock
/// that stays fails the operation as it always did.
fn sweep_stale_locks(git_dir: &Path) {
    let now = SystemTime::now();
    let mut locks = Vec::new();
    collect_locks(git_dir, false, &mut locks);
    collect_locks(&git_dir.join("refs"), true, &mut locks);
    for path in locks {
        let Ok(modified) = path.metadata().and_then(|meta| meta.modified()) else {
            continue;
        };
        if now
            .duration_since(modified)
            .is_ok_and(|age| age <= STALE_LOCK_AGE)
        {
            tracing::debug!(path = %path.display(), "keeping a fresh lock file");
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

/// `*.lock` files directly in `dir`, and below it when `recurse`. Symlinks
/// are skipped (`file_type` does not follow them), so a link out of `.git`
/// or a link cycle cannot steer the sweep.
fn collect_locks(dir: &Path, recurse: bool, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if kind.is_dir() && recurse {
            collect_locks(&path, true, out);
        } else if kind.is_file() && path.extension().is_some_and(|ext| ext == "lock") {
            out.push(path);
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
