//! Coordinate local graph mutations with Git checkout. Network operations
//! only hold the repository lock; saves wait for local checkout, never fetch.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, Weak};

use crate::error::{AppError, AppResult};

use super::{invalidate_file_catalog, root_for_generation, GraphState};

#[derive(Default)]
struct GraphLocks {
    repository: Mutex<()>,
    worktree: Mutex<()>,
}

fn locks_for(root: &Path) -> AppResult<Arc<GraphLocks>> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Weak<GraphLocks>>>> = OnceLock::new();
    let canonical = root.canonicalize()?;
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| AppError::io("graph mutation registry lock poisoned"))?;
    locks.retain(|_, locks| locks.strong_count() > 0);
    if let Some(existing) = locks.get(&canonical).and_then(Weak::upgrade) {
        return Ok(existing);
    }
    let graph = Arc::new(GraphLocks::default());
    locks.insert(canonical, Arc::downgrade(&graph));
    Ok(graph)
}

/// Run one local filesystem mutation. Callers must not nest mutation scopes.
pub(crate) fn with_root<T>(root: &Path, action: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    let locks = locks_for(root)?;
    let _guard = locks
        .worktree
        .lock()
        .map_err(|_| AppError::io("graph worktree lock poisoned"))?;
    action()
}

/// Serialize Git commands independently of ordinary graph writes. When a Git
/// command needs both locks it must take this scope before the worktree scope.
pub(crate) fn with_repository<T>(
    root: &Path,
    action: impl FnOnce() -> AppResult<T>,
) -> AppResult<T> {
    let locks = locks_for(root)?;
    let _guard = locks
        .repository
        .lock()
        .map_err(|_| AppError::io("graph repository lock poisoned"))?;
    action()
}

/// Execute a generation-pinned mutation and invalidate the catalog even on
/// failure, since filesystem operations can fail after changing some paths.
pub(crate) fn with_generation<T>(
    state: &GraphState,
    generation: u64,
    action: impl FnOnce(&Path) -> AppResult<T>,
) -> AppResult<T> {
    let root = root_for_generation(state, generation)?;
    with_root(&root, || {
        root_for_generation(state, generation)?;
        let outcome = action(&root);
        invalidate_file_catalog(state, &root);
        outcome
    })
}

/// Run local mutations on the blocking pool so waiting for checkout never
/// blocks the native event loop or keyboard input.
pub(crate) async fn run<T, F>(state: GraphState, generation: u64, action: F) -> AppResult<T>
where
    T: Send + 'static,
    F: FnOnce(&Path) -> AppResult<T> + Send + 'static,
{
    crate::blocking::run_blocking(move || with_generation(&state, generation, action)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::thread;

    fn graph_at(root: &Path) -> GraphState {
        let graph = GraphState::default();
        {
            let mut inner = graph.0.lock().unwrap();
            inner.root = Some(root.to_path_buf());
            inner.generation = 1;
        }
        graph
    }

    #[test]
    fn network_wait_does_not_block_note_saves() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let graph = graph_at(root);
        with_repository(root, || {
            with_generation(&graph, 1, |root| {
                super::super::atomic_write_bytes(
                    root,
                    &root.join("note.md"),
                    b"saved during fetch",
                )?;
                Ok(())
            })
        })
        .unwrap();
        assert_eq!(
            std::fs::read(root.join("note.md")).unwrap(),
            b"saved during fetch"
        );
    }

    #[test]
    fn mutation_excludes_checkout_and_releases_on_error() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let locks = locks_for(root).unwrap();
        let result: AppResult<()> = with_root(root, || {
            assert!(locks.worktree.try_lock().is_err());
            Err(AppError::io("injected checkout failure"))
        });
        assert!(result.is_err());
        assert!(locks.worktree.try_lock().is_ok());
        with_root(root, || Ok(())).unwrap();
    }

    #[test]
    fn queued_save_rechecks_generation_after_checkout() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path();
        let graph = graph_at(root);
        let (started_tx, started_rx) = mpsc::channel();
        let writer_graph = graph.clone();
        let locks = locks_for(root).unwrap();
        let checkout = locks.worktree.lock().unwrap();
        let writer = thread::spawn(move || {
            started_tx.send(()).unwrap();
            with_generation(&writer_graph, 1, |root| {
                std::fs::write(root.join("note.md"), b"stale save")?;
                Ok(())
            })
        });
        started_rx.recv().unwrap();
        graph.0.lock().unwrap().generation = 2;
        drop(checkout);
        assert!(writer.join().unwrap().is_err());
        assert!(!root.join("note.md").exists());
    }

    #[cfg(unix)]
    #[test]
    fn alternate_root_spellings_share_the_same_checkout_lock() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("graph");
        std::fs::create_dir(&root).unwrap();
        let alias = directory.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        assert!(Arc::ptr_eq(
            &locks_for(&root).unwrap(),
            &locks_for(&alias).unwrap()
        ));
    }
}
