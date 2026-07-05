//! The shadow base store: `.reflect/sync-base/<note-path>` holds each note's
//! content at its **last synced state** — the common-ancestor approximation
//! that turns two-way conflicts into three-way merges (Plan 21).
//!
//! The advance rule is what makes it an ancestor and not just a copy: the
//! base moves **only** when
//! - an external change is ingested cleanly (that content is now what both
//!   sides derive from),
//! - a conflict resolution lands (both devices converge on it), or
//! - a graph is adopted into iCloud sync (initial snapshot).
//!
//! Never on local saves — advancing past content the other device hasn't seen
//! would make diff3 read our own additions as already-merged and drop them.
//!
//! A missing base is safe (the ladder degrades to two-way handling); a stale
//! base is safe (identical early edits on both sides merge clean). The store
//! is a cache under the local-only `.reflect/`, rebuilt by use, never synced.
//!
//! Alongside each base lives an optional `<note-path>.pair` file recording
//! the content-hash pair of the last **auto-merged** conflict — the
//! merge-loop breaker. When devices with different bases auto-merge the same
//! pair to different results, iCloud re-conflicts them; seeing a pair you
//! already merged once means base-dependent merging cannot converge, and the
//! ladder falls to base-independent deterministic markers instead.

use std::fs;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Content identity for merge-pair tracking, via the vendored libgit2
/// (no extra hashing dependency). A hashing failure is an error, not a
/// degraded hash: a silent fallback value would blind
/// [`ShadowStore::is_repeated_merge`] to a real merge loop — the caller
/// defers the file instead (the sweep retries it next round).
pub fn content_hash(content: &str) -> AppResult<String> {
    git2::Oid::hash_object(git2::ObjectType::Blob, content.as_bytes())
        .map(|oid| oid.to_string())
        .map_err(|err| AppError::io(format!("content hash failed: {err}")))
}

/// The per-graph shadow base store.
pub struct ShadowStore {
    root: PathBuf,
    dir: PathBuf,
}

impl ShadowStore {
    /// Store for the graph at `root`. Creates nothing until first write.
    pub fn new(root: &Path) -> ShadowStore {
        ShadowStore {
            root: root.to_path_buf(),
            dir: root.join(".reflect").join("sync-base"),
        }
    }

    /// The base content for a note, when one has been recorded.
    pub fn base(&self, rel: &str) -> Option<String> {
        let path = self.entry_path(rel, "")?;
        fs::read_to_string(path).ok()
    }

    /// Record `content` as the note's synced base (atomic).
    pub fn record(&self, rel: &str, content: &str) -> AppResult<()> {
        let path = self
            .entry_path(rel, "")
            .ok_or_else(|| AppError::io(format!("invalid shadow path: {rel}")))?;
        crate::fs::atomic_write_bytes(&self.root, &path, content.as_bytes())?;
        Ok(())
    }

    /// Drop a note's base and merge-pair record (deletion, or corrupt state).
    pub fn forget(&self, rel: &str) {
        for suffix in ["", ".pair"] {
            if let Some(path) = self.entry_path(rel, suffix) {
                let _ = fs::remove_file(path);
            }
        }
    }

    /// Carry base + pair across a rename so the ancestor survives Plan 17's
    /// settled-title file moves. Best-effort: a miss just degrades one merge.
    pub fn record_move(&self, from: &str, to: &str) {
        for suffix in ["", ".pair"] {
            let (Some(source), Some(target)) =
                (self.entry_path(from, suffix), self.entry_path(to, suffix))
            else {
                continue;
            };
            if !source.exists() {
                continue;
            }
            if let Some(parent) = target.parent() {
                let _ = fs::create_dir_all(parent);
            }
            let _ = fs::rename(source, target);
        }
    }

    /// The unordered content-hash pair of the last auto-merge, if recorded.
    pub fn merge_pair(&self, rel: &str) -> Option<(String, String)> {
        let path = self.entry_path(rel, ".pair")?;
        let raw = fs::read_to_string(path).ok()?;
        let mut lines = raw.lines();
        let first = lines.next()?.trim().to_string();
        let second = lines.next()?.trim().to_string();
        (!first.is_empty() && !second.is_empty()).then_some((first, second))
    }

    /// Record that `a`/`b` (content hashes, any order) were auto-merged.
    pub fn record_merge_pair(&self, rel: &str, a: &str, b: &str) -> AppResult<()> {
        let path = self
            .entry_path(rel, ".pair")
            .ok_or_else(|| AppError::io(format!("invalid shadow path: {rel}")))?;
        let (low, high) = if a <= b { (a, b) } else { (b, a) };
        crate::fs::atomic_write_bytes(&self.root, &path, format!("{low}\n{high}\n").as_bytes())?;
        Ok(())
    }

    /// Does the incoming conflict repeat the last auto-merged pair?
    pub fn is_repeated_merge(&self, rel: &str, a: &str, b: &str) -> bool {
        let Some((low, high)) = self.merge_pair(rel) else {
            return false;
        };
        let (in_low, in_high) = if a <= b { (a, b) } else { (b, a) };
        low == in_low && high == in_high
    }

    /// Clear the merge-pair record (a conflict resolved by other means).
    pub fn clear_merge_pair(&self, rel: &str) {
        if let Some(path) = self.entry_path(rel, ".pair") {
            let _ = fs::remove_file(path);
        }
    }

    /// Drop bases (and pair records) for notes that no longer exist. In-app
    /// deletes route through `forget`, but external deletions (another
    /// device, a file manager) don't — without this the store grows
    /// monotonically. `keep` is the graph's live note listing, placeholders
    /// included. Best-effort: pruning must never fail a sweep.
    pub fn prune_orphans(&self, keep: &std::collections::BTreeSet<&str>) {
        prune_orphan_dir(&self.dir, &self.dir, keep);
    }

    /// Map a graph-relative note path into the store, refusing anything the
    /// shared traversal guard would ([`crate::fs::ensure_relative`]). Store
    /// paths mirror note paths one-to-one.
    fn entry_path(&self, rel: &str, suffix: &str) -> Option<PathBuf> {
        crate::fs::ensure_relative(rel).ok()?;
        Some(self.dir.join(format!("{rel}{suffix}")))
    }
}

fn prune_orphan_dir(dir: &Path, store_root: &Path, keep: &std::collections::BTreeSet<&str>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            prune_orphan_dir(&path, store_root, keep);
            let _ = fs::remove_dir(&path); // gone once emptied
            continue;
        }
        let Ok(rel) = path.strip_prefix(store_root) else {
            continue;
        };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let note = rel.strip_suffix(".pair").unwrap_or(&rel);
        if !keep.contains(note) {
            let _ = fs::remove_file(&path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn store() -> (tempfile::TempDir, ShadowStore) {
        let dir = tempdir().unwrap();
        fs::create_dir_all(dir.path().join(".reflect")).unwrap();
        let store = ShadowStore::new(dir.path());
        (dir, store)
    }

    #[test]
    fn records_and_reads_a_base() {
        let (_dir, store) = store();
        assert_eq!(store.base("notes/a.md"), None);
        store.record("notes/a.md", "# synced\n").unwrap();
        assert_eq!(store.base("notes/a.md"), Some("# synced\n".to_string()));
    }

    #[test]
    fn moves_carry_the_base_across_renames() {
        let (_dir, store) = store();
        store.record("notes/old.md", "content\n").unwrap();
        store.record_move("notes/old.md", "notes/new-title.md");
        assert_eq!(store.base("notes/old.md"), None);
        assert_eq!(
            store.base("notes/new-title.md"),
            Some("content\n".to_string())
        );
    }

    #[test]
    fn merge_pairs_match_in_either_order_and_clear() {
        let (_dir, store) = store();
        let (a, b) = (content_hash("one").unwrap(), content_hash("two").unwrap());
        assert!(!store.is_repeated_merge("notes/a.md", &a, &b));
        store.record_merge_pair("notes/a.md", &a, &b).unwrap();
        assert!(store.is_repeated_merge("notes/a.md", &a, &b));
        assert!(store.is_repeated_merge("notes/a.md", &b, &a));
        assert!(!store.is_repeated_merge("notes/a.md", &a, &content_hash("three").unwrap()));
        store.clear_merge_pair("notes/a.md");
        assert!(!store.is_repeated_merge("notes/a.md", &a, &b));
    }

    #[test]
    fn prune_drops_bases_for_vanished_notes_and_keeps_live_ones() {
        let (_dir, store) = store();
        store.record("notes/alive.md", "here\n").unwrap();
        store
            .record("notes/gone.md", "deleted elsewhere\n")
            .unwrap();
        store
            .record_merge_pair("notes/gone.md", "hash-a", "hash-b")
            .unwrap();

        let keep: std::collections::BTreeSet<&str> = ["notes/alive.md"].into_iter().collect();
        store.prune_orphans(&keep);

        assert_eq!(store.base("notes/alive.md"), Some("here\n".to_string()));
        assert_eq!(store.base("notes/gone.md"), None);
        assert!(!store.is_repeated_merge("notes/gone.md", "hash-a", "hash-b"));
    }

    #[test]
    fn traversal_shapes_are_refused() {
        let (dir, store) = store();
        assert!(store.record("../escape.md", "x").is_err());
        assert!(store.record("/abs.md", "x").is_err());
        assert!(store.record("notes/../../up.md", "x").is_err());
        assert!(!dir.path().parent().unwrap().join("escape.md").exists());
    }

    #[test]
    fn content_hashes_are_stable_and_distinct() {
        assert_eq!(content_hash("same").unwrap(), content_hash("same").unwrap());
        assert_ne!(
            content_hash("same").unwrap(),
            content_hash("different").unwrap()
        );
        assert_eq!(content_hash("same").unwrap().len(), 40);
    }
}
