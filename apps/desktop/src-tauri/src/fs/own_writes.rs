//! Which files this app itself wrote moments ago, by graph-relative path
//! and the mtime the write produced. The desktop watcher consults it to
//! report the echo of our own write as `index:own-write` instead of
//! `index:changed`, so consumers that must tell this device's writes from
//! everything else (the sync debounce, the iCloud shadow base) branch on
//! provenance instead of guessing from timing or content.
//!
//! Entries are consumed on match and expire after a few seconds either way:
//! the watcher's debounce delivers an echo well within that, and a stale
//! entry must never relabel a later, genuinely external write.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(5);

static RECENT: Mutex<Option<HashMap<(String, u64), Instant>>> = Mutex::new(None);

fn normalize(rel: &str) -> String {
    rel.replace('\\', "/")
}

fn with<R>(f: impl FnOnce(&mut HashMap<(String, u64), Instant>) -> R) -> R {
    let mut guard = RECENT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let recent = guard.get_or_insert_with(HashMap::new);
    let now = Instant::now();
    recent.retain(|_, at| now.duration_since(*at) < TTL);
    f(recent)
}

/// Remember that this app just wrote `rel`, producing `modified_ms`. A write
/// whose mtime is unknown cannot be matched and is not recorded.
pub(crate) fn record_own_write(rel: &str, modified_ms: Option<u64>) {
    if let Some(ms) = modified_ms {
        with(|recent| {
            recent.insert((normalize(rel), ms), Instant::now());
        });
    }
}

/// [`record_own_write`] for an absolute path under `root` (the importer
/// resolves its targets before writing).
pub(crate) fn record_own_write_at(root: &Path, target: &Path, modified_ms: Option<u64>) {
    if let Ok(rel) = target.strip_prefix(root) {
        record_own_write(&rel.to_string_lossy(), modified_ms);
    }
}

/// Whether a watcher event for `rel` with `modified_ms` is the echo of a
/// recorded own write; the entry is consumed so it matches once.
pub(crate) fn take_own_write(rel: &str, modified_ms: Option<u64>) -> bool {
    let Some(ms) = modified_ms else {
        return false;
    };
    with(|recent| recent.remove(&(normalize(rel), ms)).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recorded_write_matches_once_by_path_and_mtime() {
        record_own_write("notes/a.md", Some(4242));
        assert!(!take_own_write("notes/a.md", Some(4243)));
        assert!(!take_own_write("notes/b.md", Some(4242)));
        assert!(take_own_write("notes/a.md", Some(4242)));
        assert!(
            !take_own_write("notes/a.md", Some(4242)),
            "consumed on match"
        );
    }

    #[test]
    fn unknown_mtimes_never_match() {
        record_own_write("notes/c.md", None);
        assert!(!take_own_write("notes/c.md", None));
    }
}
