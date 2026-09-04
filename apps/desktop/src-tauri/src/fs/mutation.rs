use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, RwLock, RwLockReadGuard, Weak};

use crate::error::{AppError, AppResult};

type Locks = HashMap<PathBuf, Weak<RwLock<()>>>;

/// One gate per canonical graph, shared by all windows and native writers.
/// Network operations never acquire this gate. Writers fail promptly during
/// a checkout instead of blocking the UI; their caller retains the unsaved edit.
pub(crate) fn gate(root: &Path) -> AppResult<Arc<RwLock<()>>> {
    static LOCKS: OnceLock<Mutex<Locks>> = OnceLock::new();
    let root = root.canonicalize()?;
    let mut locks = LOCKS
        .get_or_init(Mutex::default)
        .lock()
        .map_err(|_| AppError::io("graph mutation registry poisoned"))?;
    locks.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = locks.get(&root).and_then(Weak::upgrade) {
        return Ok(lock);
    }
    let lock = Arc::new(RwLock::new(()));
    locks.insert(root, Arc::downgrade(&lock));
    Ok(lock)
}

/// Admit a short filesystem mutation without waiting on a sync checkout.
pub(crate) fn writer(gate: &RwLock<()>) -> AppResult<RwLockReadGuard<'_, ()>> {
    gate.try_read().map_err(|_| {
        AppError::io(
            "Git sync is updating this graph; the edit has not been written, retry saving shortly",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkout_refuses_writes_promptly_across_handles_but_not_other_graphs() {
        let graph = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        let first = gate(graph.path()).unwrap();
        let second = gate(&graph.path().join(".")).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        let checkout = first.write().unwrap();
        assert!(crate::fs::atomic_write_bytes(
            graph.path(),
            &graph.path().join("note.md"),
            b"edit"
        )
        .is_err());
        crate::fs::atomic_write_bytes(other.path(), &other.path().join("note.md"), b"other")
            .unwrap();
        drop(checkout);
        crate::fs::atomic_write_bytes(graph.path(), &graph.path().join("note.md"), b"edit")
            .unwrap();
        assert_eq!(
            std::fs::read(graph.path().join("note.md")).unwrap(),
            b"edit"
        );
    }
}
