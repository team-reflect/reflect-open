//! A short-lived record of note bytes this process wrote, keyed by graph
//! root and graph-relative path, so a later read can tell its own content from a
//! change that arrived from elsewhere.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(10 * 60);
const MAX_ENTRIES: usize = 4096;
/// Size an over-full record is cut back to, so pruning runs once per batch.
const PRUNED_SIZE: usize = MAX_ENTRIES * 3 / 4;

/// The graph root as its native path (no lossy slash form, so distinct roots
/// never collide) and the forward-slashed graph-relative path.
type Key = (PathBuf, String);
type Entries = HashMap<Key, (String, Instant)>;

static RECENT: LazyLock<Mutex<Entries>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// Remember that `bytes` were just written at `rel` in the graph at `root`.
pub fn record(root: &Path, rel: &str, bytes: &[u8]) {
    let Some(hash) = blob_hash(bytes) else {
        return;
    };
    let mut entries = RECENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    record_at(&mut entries, key(root, rel), hash, Instant::now());
}

/// True when the latest recorded write at `rel` in the graph at `root` holds
/// exactly `bytes`.
pub fn is_own(root: &Path, rel: &str, bytes: &[u8]) -> bool {
    let Some(hash) = blob_hash(bytes) else {
        return false;
    };
    let entries = RECENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    holds(&entries, &key(root, rel), &hash, Instant::now())
}

fn key(root: &Path, rel: &str) -> Key {
    (root.to_path_buf(), reflect_graph_paths::to_slash(rel))
}

fn blob_hash(bytes: &[u8]) -> Option<String> {
    git2::Oid::hash_object(git2::ObjectType::Blob, bytes)
        .ok()
        .map(|oid| oid.to_string())
}

fn record_at(entries: &mut Entries, key: Key, hash: String, now: Instant) {
    entries.insert(key, (hash, now));
    prune(entries, now);
}

fn holds(entries: &Entries, key: &Key, hash: &str, now: Instant) -> bool {
    entries
        .get(key)
        .is_some_and(|(recorded, at)| recorded == hash && now.duration_since(*at) < TTL)
}

fn prune(entries: &mut Entries, now: Instant) {
    entries.retain(|_, (_, at)| now.duration_since(*at) < TTL);
    if entries.len() <= MAX_ENTRIES {
        return;
    }
    let mut ages: Vec<(Instant, Key)> = entries
        .iter()
        .map(|(key, (_, at))| (*at, key.clone()))
        .collect();
    ages.sort();
    let excess = entries.len() - PRUNED_SIZE;
    for (_, key) in ages.into_iter().take(excess) {
        entries.remove(&key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_write_is_own_until_the_content_changes() {
        let root = Path::new("/graphs/own-writes-probe");
        record(root, "notes/a.md", b"mine\n");
        assert!(is_own(root, "notes/a.md", b"mine\n"));
        assert!(!is_own(root, "notes/a.md", b"theirs\n"));
        assert!(!is_own(root, "notes/b.md", b"mine\n"));
        assert!(!is_own(Path::new("/graphs/other"), "notes/a.md", b"mine\n"));
        // A backslash is a filename byte on Unix: a different root, not `/`.
        if cfg!(unix) {
            let sibling = Path::new("/graphs\\own-writes-probe");
            assert!(!is_own(sibling, "notes/a.md", b"mine\n"));
        }
        record(root, "notes/a.md", b"newer\n");
        assert!(!is_own(root, "notes/a.md", b"mine\n"));
        assert!(is_own(root, "notes/a.md", b"newer\n"));
    }

    fn k(rel: &str) -> Key {
        key(Path::new("/graphs/g"), rel)
    }

    #[test]
    fn entries_expire_after_the_ttl() {
        let mut entries = Entries::new();
        let start = Instant::now();
        record_at(&mut entries, k("a.md"), "h".into(), start);
        assert!(holds(
            &entries,
            &k("a.md"),
            "h",
            start + TTL - Duration::from_secs(1)
        ));
        assert!(!holds(&entries, &k("a.md"), "h", start + TTL));
        record_at(&mut entries, k("b.md"), "h".into(), start + TTL);
        assert!(!entries.contains_key(&k("a.md")));
        assert!(entries.contains_key(&k("b.md")));
    }

    #[test]
    fn the_oldest_entries_go_beyond_the_cap() {
        let mut entries = Entries::new();
        let start = Instant::now();
        for index in 0..MAX_ENTRIES + 3 {
            let at = start + Duration::from_millis(index as u64);
            record_at(&mut entries, k(&format!("{index}.md")), "h".into(), at);
        }
        assert!(entries.len() <= MAX_ENTRIES);
        for index in 0..MAX_ENTRIES / 4 {
            assert!(!entries.contains_key(&k(&format!("{index}.md"))));
        }
        assert!(entries.contains_key(&k(&format!("{}.md", MAX_ENTRIES + 2))));
    }
}
