//! Keep device-local runtime data out of Git's index and working-tree updates.

use std::path::Path;

use git2::{Index, Repository, Tree};

use crate::error::AppResult;

/// Whether a graph-relative path addresses the reserved runtime directory.
/// Case variants and Windows trailing-dot/space aliases are reserved on every
/// platform so a portable backup cannot address another device's live database.
pub(super) fn is_runtime_path(path: &Path) -> bool {
    path.components()
        .next()
        .is_some_and(|component| is_runtime_name(component.as_os_str().as_encoded_bytes()))
}

fn is_runtime_name(name: &[u8]) -> bool {
    let end = name
        .iter()
        .rposition(|byte| *byte != b'.' && *byte != b' ')
        .map_or(0, |position| position + 1);
    name[..end].eq_ignore_ascii_case(b".reflect")
}

/// Remove runtime entries from the index without touching their working copies.
/// Ignore rules alone cannot exclude files tracked by an adopted repository.
pub(super) fn remove_from_index(index: &mut Index) -> AppResult<()> {
    index.remove_all(
        ["*"],
        Some(&mut |path: &Path, _spec: &[u8]| {
            if is_runtime_path(path) {
                0
            } else {
                1
            }
        }),
    )?;
    Ok(())
}

/// Apply runtime exclusion when adopting or restoring a backup repository.
pub(super) fn exclude_from_index(repo: &Repository) -> AppResult<()> {
    repo.add_ignore_rule("/.reflect/")?;
    let mut index = repo.index()?;
    remove_from_index(&mut index)?;
    index.write()?;
    Ok(())
}

/// Build a tree containing only portable graph data. The original tree and
/// historical commits remain intact; no runtime files are read or removed.
pub(super) fn without_runtime<'repo>(
    repo: &'repo Repository,
    tree: &Tree<'_>,
) -> AppResult<Tree<'repo>> {
    let mut builder = repo.treebuilder(Some(tree))?;
    for entry in tree.iter() {
        if is_runtime_name(entry.name_bytes()) {
            builder.remove(entry.name_bytes())?;
        }
    }
    Ok(repo.find_tree(builder.write()?)?)
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;
