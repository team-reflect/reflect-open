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

/// Refuse to operate on a repository mid-operation (a rebase/merge the user
/// started with the git CLI). Guessing here could destroy their state.
pub(super) fn ensure_clean_state(repo: &Repository) -> AppResult<()> {
    if repo.path().join("reflect-sync/pending").exists() {
        return Err(AppError::io(format!(
            "an interrupted Git sync needs recovery; original files and index are in {}. Inspect pending before retrying; do not reset --hard",
            repo.path().join("reflect-sync").display()
        )));
    }
    if repo.state() != git2::RepositoryState::Clean {
        return Err(AppError::io(format!(
            "the backup repository has a {:?} in progress; finish or abort it with git first",
            repo.state()
        )));
    }
    if repo.index()?.has_conflicts() {
        return Err(AppError::io(
            "the Git index has unresolved conflicts; resolve them with git before syncing",
        ));
    }
    Ok(())
}

/// Runtime data never participates in history or checkout, even when tracked
/// by an adopted repository. Case folding also protects case-insensitive disks.
pub(super) fn is_runtime(path: &[u8]) -> bool {
    path.split(|byte| *byte == b'/').next().is_some_and(|part| {
        let end = part
            .iter()
            .rposition(|byte| *byte != b'.' && *byte != b' ')
            .map_or(0, |position| position + 1);
        part[..end].eq_ignore_ascii_case(b".reflect")
    })
}

/// Remove runtime entries from every index stage without touching local files.
pub(super) fn exclude_runtime(index: &mut git2::Index) -> AppResult<()> {
    let paths: Vec<_> = index
        .iter()
        .filter(|entry| is_runtime(&entry.path))
        .map(|entry| {
            String::from_utf8(entry.path).map_err(|_| AppError::io("non-UTF-8 runtime path"))
        })
        .collect::<AppResult<_>>()?;
    for path in paths {
        index.remove_path(Path::new(&path))?;
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

#[cfg(test)]
mod runtime_tests {
    use super::is_runtime;

    #[test]
    fn reserves_case_and_windows_trailing_dot_space_aliases() {
        for path in [
            ".reflect/index.sqlite",
            ".REFLECT/index.sqlite-wal",
            ".reflect./index.sqlite",
            ".ReFlEcT . ./chat",
            ".reflect",
        ] {
            assert!(is_runtime(path.as_bytes()), "{path}");
        }
        for path in [
            "notes/.reflect.md",
            ".reflect-notes/a.md",
            "notes/a.md",
            ".../note",
        ] {
            assert!(!is_runtime(path.as_bytes()), "{path}");
        }
    }
}
