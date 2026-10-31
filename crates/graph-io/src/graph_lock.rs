//! One lock per graph root, taken around operations that rewrite or remove
//! files under that root.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};

use reflect_types::AppResult;

type GraphMutex = Arc<Mutex<()>>;

static LOCKS: LazyLock<Mutex<HashMap<PathBuf, GraphMutex>>> = LazyLock::new(Mutex::default);

/// The canonical root, or the canonical parent plus the final name when the
/// root does not exist yet, or the path as given when nothing resolves.
fn lock_key(root: &Path) -> PathBuf {
    if let Ok(canonical) = root.canonicalize() {
        return canonical;
    }
    if let (Some(parent), Some(name)) = (root.parent(), root.file_name())
        && let Ok(canonical) = parent.canonicalize()
    {
        return canonical.join(name);
    }
    root.to_path_buf()
}

/// Run `f` while holding the lock of the graph at `root`. The function is
/// synchronous: never call it across an `.await`. The lock is not reentrant:
/// `f` must not take it again for the same root.
pub fn with_graph_lock<T>(root: &Path, f: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    let mutex = {
        let mut locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
        locks.entry(lock_key(root)).or_default().clone()
    };
    let _guard = mutex.lock().unwrap_or_else(PoisonError::into_inner);
    f()
}

/// How many threads hold or wait on the lock of `root`.
#[cfg(any(test, feature = "test-support"))]
pub fn holders(root: &Path) -> usize {
    let locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
    locks
        .get(&lock_key(root))
        .map_or(0, |mutex| Arc::strong_count(mutex) - 1)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn two_threads_on_one_root_serialize() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let inside = Arc::new(AtomicBool::new(false));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let first = {
            let (root, inside) = (root.clone(), inside.clone());
            std::thread::spawn(move || {
                with_graph_lock(&root, || {
                    inside.store(true, Ordering::SeqCst);
                    entered_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    inside.store(false, Ordering::SeqCst);
                    Ok(())
                })
            })
        };
        entered_rx.recv().unwrap();
        let second = {
            let (root, inside) = (root.clone(), inside.clone());
            std::thread::spawn(move || {
                with_graph_lock(&root, || {
                    assert!(!inside.load(Ordering::SeqCst), "ran inside the first hold");
                    Ok(())
                })
            })
        };
        std::thread::sleep(Duration::from_millis(50));
        assert!(!second.is_finished());
        release_tx.send(()).unwrap();
        first.join().unwrap().unwrap();
        second.join().unwrap().unwrap();
    }

    #[test]
    fn two_roots_do_not_block_each_other() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        with_graph_lock(a.path(), || with_graph_lock(b.path(), || Ok(()))).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_alias_maps_to_the_same_lock() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("real");
        std::fs::create_dir(&real).unwrap();
        let alias = dir.path().join("alias");
        std::os::unix::fs::symlink(&real, &alias).unwrap();
        assert_eq!(lock_key(&real), lock_key(&alias));
    }
}
