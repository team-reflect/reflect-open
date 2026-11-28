//! Recent-graphs list (Plan 02).
//!
//! The recents list lives in the OS config dir — **never** inside any one
//! graph's `.reflect/` — so it survives graph deletion and isn't synced as note
//! content.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use reflect_types::{AppError, AppResult, RecentGraph};

use crate::Core;
use crate::json_store::{load_json, save_json};

const MAX_RECENTS: usize = 12;

fn store_path() -> AppResult<PathBuf> {
    let base = dirs::config_dir().ok_or_else(|| AppError::io("no OS config dir"))?;
    Ok(base.join("reflect-open").join("recent-graphs.json"))
}

/// Prepend `entry`, dedupe by `root`, and cap the list. Pure (unit-tested).
fn with_entry(mut recents: Vec<RecentGraph>, entry: RecentGraph) -> Vec<RecentGraph> {
    recents.retain(|r| r.root != entry.root);
    recents.insert(0, entry);
    recents.truncate(MAX_RECENTS);
    recents
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_millis() as u64)
        .unwrap_or(0)
}

/// Record a graph as most-recently-opened.
pub fn record(root: &Path, name: &str) -> AppResult<()> {
    let path = store_path()?;
    let entry = RecentGraph {
        root: root.to_string_lossy().into_owned(),
        name: name.to_string(),
        opened_ms: now_ms(),
    };
    save_json(&path, &with_entry(load_json(&path)?, entry))
}

/// The recent-graphs list, newest first.
pub fn list() -> AppResult<Vec<RecentGraph>> {
    load_json(&store_path()?)
}

/// Drop a graph from the recents list (by root path).
pub fn forget(root: &str) -> AppResult<()> {
    let path = store_path()?;
    let mut recents: Vec<RecentGraph> = load_json(&path)?;
    recents.retain(|r| r.root != root);
    save_json(&path, &recents)
}

impl Core {
    /// Command: the recent-graphs list, newest first.
    pub fn recent_graphs(&self) -> AppResult<Vec<RecentGraph>> {
        list()
    }

    /// Command: drop a graph from recents (by root path).
    pub fn forget_recent(&self, root: String) -> AppResult<()> {
        forget(&root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn entry(root: &str, opened_ms: u64) -> RecentGraph {
        RecentGraph {
            root: root.to_string(),
            name: root.rsplit('/').next().unwrap_or(root).to_string(),
            opened_ms,
        }
    }

    #[test]
    fn prepends_dedupes_and_caps() {
        let mut list = Vec::new();
        for i in 0..15 {
            list = with_entry(list, entry(&format!("/g/{i}"), i));
        }
        assert_eq!(list.len(), MAX_RECENTS);
        assert_eq!(list[0].root, "/g/14"); // newest first

        // Re-opening an existing root moves it to front without duplicating.
        let list = with_entry(list, entry("/g/10", 99));
        assert_eq!(list[0].root, "/g/10");
        assert_eq!(list.iter().filter(|r| r.root == "/g/10").count(), 1);
        assert_eq!(list.len(), MAX_RECENTS);
    }

    #[test]
    fn save_load_round_trip() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("recent-graphs.json");
        let recents = vec![entry("/a", 1), entry("/b", 2)];
        save_json(&path, &recents).unwrap();
        assert_eq!(load_json::<Vec<RecentGraph>>(&path).unwrap(), recents);
    }

    #[test]
    fn missing_store_loads_empty() {
        let dir = tempdir().unwrap();
        assert!(
            load_json::<Vec<RecentGraph>>(&dir.path().join("nope.json"))
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn corrupt_store_errors_instead_of_wiping() {
        // A malformed store must surface an error, not silently read as empty
        // (which a later save would persist, destroying the real entries).
        let dir = tempdir().unwrap();
        let path = dir.path().join("recent-graphs.json");
        fs::write(&path, b"{ this is not json").unwrap();
        assert!(load_json::<Vec<RecentGraph>>(&path).is_err());
    }
}
