//! Repository plumbing: open/init/adopt, branch + signature resolution, and
//! the `.reflect/` ignore guarantee.

use std::fs;
use std::io::Write;
use std::path::Path;

use git2::{Repository, RepositoryInitOptions, Signature};

use crate::error::{AppError, AppResult};

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
    Ok(Repository::init_opts(root, &opts)?)
}

/// Open the graph's repository; errors if backup was never set up.
pub(super) fn open_existing(root: &Path) -> AppResult<Repository> {
    if !root.join(".git").exists() {
        return Err(AppError::not_found("backup is not set up for this graph"));
    }
    Ok(Repository::open(root)?)
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

/// Make sure `.reflect/` is ignored even in adopted repos whose `.gitignore`
/// predates Reflect. The graph bootstrap (Plan 02) already writes one, but a
/// user pointing Reflect at an existing repo may have their own. Idempotent:
/// an existing `.reflect` entry (any common spelling) is left alone.
pub(super) fn ensure_reflect_ignored(root: &Path) -> AppResult<()> {
    let path = root.join(".gitignore");
    let existing = fs::read_to_string(&path).unwrap_or_default();
    let already = existing.lines().any(|line| {
        matches!(
            line.trim(),
            "/.reflect/" | ".reflect/" | "/.reflect" | ".reflect"
        )
    });
    if already {
        return Ok(());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    let separator = if existing.is_empty() || existing.ends_with('\n') {
        ""
    } else {
        "\n"
    };
    write!(
        file,
        "{separator}# Reflect local index + caches (rebuildable; never committed)\n/.reflect/\n"
    )?;
    Ok(())
}
