//! One lock per graph root, taken around operations that rewrite or remove
//! files under that root.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use crate::error::AppResult;

type GraphMutex = Arc<Mutex<()>>;

static LOCKS: Mutex<Option<HashMap<PathBuf, GraphMutex>>> = Mutex::new(None);

/// The canonical root, or the canonical parent plus the final name when the
/// root does not exist yet, or the path as given when nothing resolves.
fn lock_key(root: &Path) -> PathBuf {
    if let Ok(canonical) = root.canonicalize() {
        return canonical;
    }
    if let (Some(parent), Some(name)) = (root.parent(), root.file_name()) {
        if let Ok(canonical) = parent.canonicalize() {
            return canonical.join(name);
        }
    }
    root.to_path_buf()
}

/// Drops the registry entry of `key` when no other holder or waiter remains.
/// It runs on unwind too.
struct Prune<'a> {
    key: &'a Path,
    mutex: GraphMutex,
}

impl Drop for Prune<'_> {
    fn drop(&mut self) {
        let mut locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(map) = locks.as_mut() {
            // Two handles remain when this guard and the map entry are the only owners.
            if Arc::strong_count(&self.mutex) == 2 {
                map.remove(self.key);
            }
        }
    }
}

/// Run `f` while holding the lock of the graph at `root`. The function is
/// synchronous: never call it across an `.await`.
pub fn with_graph_lock<T>(root: &Path, f: impl FnOnce() -> AppResult<T>) -> AppResult<T> {
    let key = lock_key(root);
    let mutex = {
        let mut locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
        locks
            .get_or_insert_with(HashMap::new)
            .entry(key.clone())
            .or_default()
            .clone()
    };
    let prune = Prune { key: &key, mutex };
    let _guard = prune.mutex.lock().unwrap_or_else(PoisonError::into_inner);
    f()
}

/// How many threads hold or wait on the lock of `root`.
#[cfg(test)]
pub(crate) fn holders(root: &Path) -> usize {
    let locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
    locks
        .as_ref()
        .and_then(|map| map.get(&lock_key(root)))
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

    #[test]
    fn the_entry_is_removed_after_the_last_holder_leaves() {
        let dir = tempfile::tempdir().unwrap();
        let key = lock_key(dir.path());
        with_graph_lock(dir.path(), || Ok(())).unwrap();
        let locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
        assert!(locks.as_ref().is_none_or(|map| !map.contains_key(&key)));
    }

    #[test]
    fn a_panicking_closure_still_prunes_the_registry() {
        let dir = tempfile::tempdir().unwrap();
        let key = lock_key(dir.path());
        let outcome = std::panic::catch_unwind(|| {
            let _ = with_graph_lock(dir.path(), || -> AppResult<()> { panic!("boom") });
        });
        assert!(outcome.is_err());
        let locks = LOCKS.lock().unwrap_or_else(PoisonError::into_inner);
        assert!(locks.as_ref().is_none_or(|map| !map.contains_key(&key)));
    }
}
