//! Repository plumbing: open/init/adopt, branch + signature resolution, and
//! graph `.gitignore` defaults.

use std::path::Path;

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

/// Open the graph's repository; errors if backup was never set up.
pub(super) fn open_existing(root: &Path) -> AppResult<Repository> {
    if !root.join(".git").exists() {
        return Err(AppError::not_found("backup is not set up for this graph"));
    }
    Ok(Repository::open(root)?)
}

/// Clear a merge or rebase state this app did not start (a git CLI left it).
/// The working tree is untouched: its content commits like any other edit.
pub(super) fn clear_foreign_state(repo: &Repository) -> AppResult<()> {
    let state = repo.state();
    if state != git2::RepositoryState::Clean {
        tracing::warn!(?state, "clearing a repository state this app did not start");
        repo.cleanup_state()?;
    }
    Ok(())
}

/// The branch HEAD points at. Works on an unborn HEAD (where `repo.head()`
/// errors). A detached HEAD reports the backup branch that
/// [`reattach_head`] would reattach.
pub(super) fn current_branch(repo: &Repository) -> AppResult<String> {
    let head = repo.find_reference("HEAD")?;
    match head.symbolic_target()? {
        Some(target) => Ok(target.trim_start_matches("refs/heads/").to_string()),
        None => Ok(backup_branch(repo)),
    }
}

/// The local branch a detached HEAD belongs to: one whose tip is the HEAD
/// commit or an ancestor of it, else one that tracks `origin`, else `main`,
/// else any local branch.
fn backup_branch(repo: &Repository) -> String {
    let names: Vec<String> = repo
        .branches(Some(git2::BranchType::Local))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|(branch, _)| branch.name().ok().flatten().map(str::to_string))
        .collect();
    let head = repo.head().ok().and_then(|head| head.target());
    let behind_head = |name: &&String| {
        let tip = repo.refname_to_id(&format!("refs/heads/{name}")).ok();
        match (head, tip) {
            (Some(head), Some(tip)) => {
                head == tip || repo.graph_descendant_of(head, tip).unwrap_or(false)
            }
            _ => false,
        }
    };
    let tracked = |name: &&String| {
        repo.find_reference(&format!("refs/remotes/origin/{name}"))
            .is_ok()
    };
    names
        .iter()
        .find(behind_head)
        .or_else(|| names.iter().find(tracked))
        .or_else(|| names.iter().find(|name| *name == DEFAULT_BRANCH))
        .or(names.first())
        .cloned()
        .unwrap_or_else(|| DEFAULT_BRANCH.to_string())
}

/// Attach a detached HEAD to the backup branch. The branch moves to the HEAD
/// commit only when it does not exist or its tip is HEAD or an ancestor of
/// it; otherwise it stays where it is, so no commit leaves the branch. The
/// working tree is not touched.
pub(super) fn reattach_head(repo: &Repository) -> AppResult<()> {
    let head = repo.find_reference("HEAD")?;
    if head.symbolic_target()?.is_some() {
        return Ok(());
    }
    let commit = repo.head()?.peel_to_commit()?;
    let name = backup_branch(repo);
    tracing::warn!(%name, "reattaching a detached HEAD to the backup branch");
    let tip = repo.refname_to_id(&format!("refs/heads/{name}")).ok();
    let forward = tip.is_none_or(|tip| {
        tip == commit.id() || repo.graph_descendant_of(commit.id(), tip).unwrap_or(false)
    });
    if forward {
        repo.branch(&name, &commit, true)?;
    }
    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(())
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
