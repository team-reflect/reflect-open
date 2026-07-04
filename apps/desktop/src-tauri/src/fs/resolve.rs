//! Path resolution + the path-traversal guard.
//!
//! All frontend-supplied paths are **graph-relative**; this module is the only
//! way they become absolute paths. Two layers keep them inside the graph root:
//! a lexical check ([`ensure_relative`]) rejecting absolute/`..` paths, and a
//! symlink-aware check ([`resolve`]) canonicalizing the deepest existing
//! ancestor so a symlink planted inside the graph can't redirect IO outside it.

use std::path::{Component, Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Reject a relative path that is absolute, contains `..`/root components, or is
/// empty/dot-only (which would target the graph root itself). Requires at least
/// one real path segment. The primary, lexical path-traversal guard — and the
/// only applicable one for the conflict stores under `.reflect/` (shadow bases,
/// conflict archive), whose directories don't exist until first write and so
/// can't anchor the symlink-aware [`resolve`].
pub(crate) fn ensure_relative(rel: &str) -> AppResult<PathBuf> {
    let path = Path::new(rel);
    let mut has_segment = false;
    for component in path.components() {
        match component {
            Component::Normal(_) => has_segment = true,
            Component::CurDir => {}
            _ => {
                return Err(AppError::traversal(format!(
                    "path escapes the graph root: {rel}"
                )))
            }
        }
    }
    if !has_segment {
        return Err(AppError::traversal(format!(
            "path must point to a file inside the graph, got: {rel:?}"
        )));
    }
    Ok(path.to_path_buf())
}

/// The deepest existing ancestor of `path` (the path itself if it exists).
fn existing_ancestor(path: &Path) -> PathBuf {
    let mut current = path;
    loop {
        if current.exists() {
            return current.to_path_buf();
        }
        match current.parent() {
            Some(parent) if !parent.as_os_str().is_empty() => current = parent,
            _ => return path.to_path_buf(),
        }
    }
}

/// Resolve a graph-relative path to an absolute path **inside** `root`. Beyond
/// the lexical guard, this canonicalizes the deepest existing ancestor and
/// verifies it stays under the canonicalized root, so a symlink inside the graph
/// can't redirect reads/writes outside it.
pub(crate) fn resolve(root: &Path, rel: &str) -> AppResult<PathBuf> {
    let rel = ensure_relative(rel)?;
    let joined = root.join(&rel);
    let canonical_root = root.canonicalize()?;
    let anchor = existing_ancestor(&joined).canonicalize()?;
    if !anchor.starts_with(&canonical_root) {
        return Err(AppError::traversal(format!(
            "path resolves outside the graph: {rel:?}"
        )));
    }
    Ok(joined)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::io::bootstrap;
    use tempfile::tempdir;

    #[test]
    fn rejects_path_traversal() {
        assert!(ensure_relative("../secret").is_err());
        assert!(ensure_relative("/etc/passwd").is_err());
        assert!(ensure_relative("notes/../../escape.md").is_err());
        assert!(ensure_relative("notes/ok.md").is_ok());
        assert!(ensure_relative("./daily/2026-06-09.md").is_ok());
    }

    #[test]
    fn rejects_empty_and_dot_only_paths() {
        // These would otherwise resolve to the graph root itself.
        assert!(ensure_relative("").is_err());
        assert!(ensure_relative(".").is_err());
        assert!(ensure_relative("./.").is_err());
    }

    #[test]
    fn resolve_accepts_in_graph_path() {
        let dir = tempdir().unwrap();
        bootstrap(dir.path()).unwrap();
        assert!(resolve(dir.path(), "notes/ok.md").is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn resolve_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;
        let outside = tempdir().unwrap();
        let graph = tempdir().unwrap();
        bootstrap(graph.path()).unwrap();
        // A symlink inside the graph pointing out of it.
        symlink(outside.path(), graph.path().join("notes/escape")).unwrap();
        assert!(resolve(graph.path(), "notes/escape/evil.md").is_err());
    }
}
