//! Graph resolution: `--graph` flag → `REFLECT_GRAPH` env → git-style walk-up
//! from the current directory to the nearest ancestor containing `.reflect/`.
//! Deliberately no desktop recents-config fallback (Plan 14) — the CLI must be
//! deterministic for scripts and agents.

use std::path::{Path, PathBuf};

use reflect_index_schema::REFLECT_DIR;

use crate::error::CliError;

/// The resolved graph; `root` is canonicalized and absolute.
#[derive(Debug)]
pub struct Graph {
    pub root: PathBuf,
}

const NO_GRAPH_HELP: &str =
    "no graph found — run inside a graph (a directory containing .reflect/), \
     pass --graph <path>, or set REFLECT_GRAPH";

fn is_graph(path: &Path) -> bool {
    path.join(REFLECT_DIR).is_dir()
}

fn canonical_graph(path: &Path) -> Result<Graph, CliError> {
    let root = path
        .canonicalize()
        .map_err(|err| CliError::Runtime(format!("cannot resolve {}: {err}", path.display())))?;
    Ok(Graph { root })
}

/// Validate an explicitly-named graph (flag or env var); a non-graph path is
/// an error with the hint, never a silent fall-through.
fn explicit_graph(path: &Path, source: &str) -> Result<Graph, CliError> {
    if !path.is_dir() {
        return Err(CliError::Runtime(format!(
            "{source}: no such directory: {}",
            path.display()
        )));
    }
    if !is_graph(path) {
        return Err(CliError::Runtime(format!(
            "{source}: not a Reflect graph (no {REFLECT_DIR}/ directory): {}",
            path.display()
        )));
    }
    canonical_graph(path)
}

/// Resolve the active graph. First hit wins: flag, env, then the walk-up.
pub fn resolve(flag: Option<&Path>) -> Result<Graph, CliError> {
    if let Some(path) = flag {
        return explicit_graph(path, "--graph");
    }
    if let Some(env) = std::env::var_os("REFLECT_GRAPH") {
        if !env.is_empty() {
            return explicit_graph(Path::new(&env), "REFLECT_GRAPH");
        }
    }
    let cwd = std::env::current_dir()?;
    let mut current = cwd.as_path();
    loop {
        if is_graph(current) {
            return canonical_graph(current);
        }
        match current.parent() {
            Some(parent) => current = parent,
            None => return Err(CliError::runtime(NO_GRAPH_HELP)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn explicit_non_graph_is_an_error_not_a_fallthrough() {
        let dir = tempdir().unwrap();
        let err = explicit_graph(dir.path(), "--graph").unwrap_err();
        assert!(err.to_string().contains("not a Reflect graph"));
        assert_eq!(err.exit_code(), 1);
    }

    #[test]
    fn explicit_graph_resolves_when_reflect_dir_exists() {
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join(REFLECT_DIR)).unwrap();
        let graph = explicit_graph(dir.path(), "--graph").unwrap();
        assert!(graph.root.join(REFLECT_DIR).is_dir());
    }
}
