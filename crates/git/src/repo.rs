//! Repository plumbing: open/init/adopt, branch + signature resolution, and
//! graph `.gitignore` defaults.

use std::path::Path;

use git2::{IndexEntry, IndexTime, Oid, Repository, RepositoryInitOptions, Signature};

use reflect_graph_io::graph_gitignore;
use reflect_types::{AppError, AppResult};

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
    // Two devices syncing one object store through iCloud corrupts it.
    reflect_graph_io::io::mark_dir_local_only(&root.join(".git"));
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

/// Attach a detached HEAD to the backup branch, moving the branch forward to
/// HEAD; HEAD stays detached while [`branch_tip_ahead_of_detached_head`] is set.
pub(super) fn reattach_head(repo: &Repository) -> AppResult<()> {
    let head = repo.find_reference("HEAD")?;
    if head.symbolic_target()?.is_some() || branch_tip_ahead_of_detached_head(repo)?.is_some() {
        return Ok(());
    }
    let commit = repo.head()?.peel_to_commit()?;
    let name = backup_branch(repo);
    tracing::warn!(%name, "reattaching a detached HEAD to the backup branch");
    repo.branch(&name, &commit, true)?;
    repo.set_head(&format!("refs/heads/{name}"))?;
    Ok(())
}

/// The backup branch tip when HEAD is detached and the tip is neither the
/// HEAD commit nor an ancestor of it: moving the branch to HEAD would drop
/// commits, so the tip must be merged into HEAD first.
pub(super) fn branch_tip_ahead_of_detached_head(repo: &Repository) -> AppResult<Option<Oid>> {
    let head = repo.find_reference("HEAD")?;
    if head.symbolic_target()?.is_some() {
        return Ok(None);
    }
    let head = repo.head()?.peel_to_commit()?.id();
    let name = backup_branch(repo);
    let Ok(tip) = repo.refname_to_id(&format!("refs/heads/{name}")) else {
        return Ok(None);
    };
    let behind = tip != head && !repo.graph_descendant_of(head, tip)?;
    Ok(behind.then_some(tip))
}

/// Rename the local branch to `name` so fetch/merge/push target the branch
/// the backup repo uses. HEAD's commit and the working tree do not change.
/// A stale local branch already named `name` loses the name (force rename).
pub(super) fn align_branch(repo: &Repository, name: &str) -> AppResult<()> {
    let current = current_branch(repo)?;
    if current == name {
        return Ok(());
    }
    if let Ok(reference) = repo.find_reference(&format!("refs/heads/{current}")) {
        git2::Branch::wrap(reference).rename(name, true)?;
    }
    // An unborn HEAD has no ref to rename; the first commit creates it.
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

/// A stage-0 index entry for `path` with zeroed stat data.
pub(super) fn stage0_entry(path: &str, id: Oid, mode: u32) -> IndexEntry {
    IndexEntry {
        ctime: IndexTime::new(0, 0),
        mtime: IndexTime::new(0, 0),
        dev: 0,
        ino: 0,
        mode,
        uid: 0,
        gid: 0,
        file_size: 0,
        id,
        flags: path.len().min(0x0FFF) as u16,
        flags_extended: 0,
        path: path.as_bytes().to_vec(),
    }
}

/// Make sure graph repositories carry Reflect's safe ignore defaults. The graph
/// bootstrap already writes these, but setup may adopt an existing repository.
pub(super) fn ensure_gitignore_defaults(root: &Path) -> AppResult<()> {
    graph_gitignore::ensure_defaults(root)
}
