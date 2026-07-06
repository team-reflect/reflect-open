//! The native half of the open-path reconcile (`index_reconcile_scan`).
//!
//! Comparing the file listing against the stored index rows used to happen in
//! the webview: `list_files` serialized every entry over IPC, TS loaded every
//! stored row through the query bridge, and a JS loop with event-loop yields
//! crawled the listing — seconds of overhead on a large graph to conclude,
//! almost always, "nothing changed". This module does the same comparison in
//! native code and returns only the **delta**, so the TS reconcile touches
//! exactly the files that need work (typically none).

use std::collections::{HashMap, HashSet};

use rusqlite::Connection;
use serde::Serialize;

use crate::error::AppResult;
use crate::fs::FileMeta;

/// Mirrors `MTIME_TRUST_AGE_MS` in `packages/core/src/indexing/hash.ts`: an
/// mtime match may only skip the read once the file has settled — local write
/// echoes stamp rows at write time, so two same-millisecond saves could
/// otherwise read as "unchanged".
const MTIME_TRUST_AGE_MS: u64 = 5_000;

/// One file the TS reconcile must read: its listed mtime doesn't match the
/// stored row (or is too fresh to trust), or it has no row at all. Stored
/// facts ride along so the reconcile needs no follow-up query — a `None`
/// hash marks an arrival (move-healing candidate).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanCandidate {
    pub path: String,
    /// The file's listed on-disk mtime (epoch ms).
    pub modified_ms: u64,
    /// The stored row's mtime, or `None` when the path has no row.
    pub stored_mtime: Option<i64>,
    /// The stored row's content hash, or `None` when the path has no row.
    pub stored_hash: Option<String>,
}

/// A stored row whose file vanished from disk. Facts ride along because
/// id-based move healing pairs orphans with arrivals and, on a heal, the
/// moved row's hash decides whether the new path needs a re-index at all.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanOrphan {
    pub path: String,
    pub stored_mtime: i64,
    pub stored_hash: String,
}

/// The reconcile delta: what changed on disk relative to the index.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileScan {
    /// Markdown files listed (eviction placeholders included).
    pub total: u64,
    pub candidates: Vec<ScanCandidate>,
    pub orphans: Vec<ScanOrphan>,
}

impl ReconcileScan {
    /// The "nothing to do" scan a superseded generation reports.
    pub fn empty() -> Self {
        ReconcileScan {
            total: 0,
            candidates: Vec::new(),
            orphans: Vec::new(),
        }
    }
}

/// Compare `files` (the note listing) against the stored `notes` rows.
///
/// Classification mirrors the TS reconcile it replaces: an eviction
/// placeholder is present-but-unreadable (never a candidate, never orphaned);
/// a row whose mtime equals the listing and has settled past
/// [`MTIME_TRUST_AGE_MS`] is skipped without a read; everything else — moved
/// mtimes, too-fresh mtimes, and rowless arrivals — is a candidate the TS
/// side reads and hashes (hashes stay the authority for "did content
/// change"). Rows with no listed file are orphans.
pub(super) fn scan_reconcile(
    conn: &Connection,
    files: &[FileMeta],
    now_ms: u64,
) -> AppResult<ReconcileScan> {
    let mut stored: HashMap<String, (i64, String)> = HashMap::new();
    let mut stmt = conn.prepare_cached("SELECT path, mtime, file_hash FROM notes")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?)))
    })?;
    for row in rows {
        let (path, facts) = row?;
        stored.insert(path, facts);
    }

    let mut candidates = Vec::new();
    let mut on_disk: HashSet<&str> = HashSet::with_capacity(files.len());
    for file in files {
        on_disk.insert(file.path.as_str());
        if file.placeholder {
            continue; // evicted to iCloud — unreadable until re-download
        }
        let facts = stored.get(&file.path);
        let settled = now_ms.saturating_sub(file.modified_ms) >= MTIME_TRUST_AGE_MS;
        if settled && facts.is_some_and(|(mtime, _)| *mtime == file.modified_ms as i64) {
            continue; // untouched since it was indexed
        }
        candidates.push(ScanCandidate {
            path: file.path.clone(),
            modified_ms: file.modified_ms,
            stored_mtime: facts.map(|(mtime, _)| *mtime),
            stored_hash: facts.map(|(_, hash)| hash.clone()),
        });
    }

    let mut orphans: Vec<ScanOrphan> = stored
        .into_iter()
        .filter(|(path, _)| !on_disk.contains(path.as_str()))
        .map(|(path, (stored_mtime, stored_hash))| ScanOrphan {
            path,
            stored_mtime,
            stored_hash,
        })
        .collect();
    // HashMap iteration order is arbitrary; a stable order keeps move-healing
    // pairing and removal deterministic across runs.
    orphans.sort_by(|first, second| first.path.cmp(&second.path));

    Ok(ReconcileScan {
        total: files.len() as u64,
        candidates,
        orphans,
    })
}
