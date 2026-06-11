//! Read-only access to `.reflect/index.sqlite` plus staleness detection.
//!
//! The CLI never writes: connections open `SQLITE_OPEN_READ_ONLY` with
//! `query_only` belt-and-braces and a busy timeout to coexist with the desktop
//! writer (the DB is WAL). Staleness uses the indexer's content SHA-256 as the
//! truth (sync providers rewrite mtimes, so an mtime mismatch alone must not
//! flag), gated on mtime divergence for speed. The gate is deliberately
//! cheaper than the desktop's `reconcileIndex`, which hashes every file on
//! open: this check runs per `search` invocation, and the accepted cost is
//! that an external edit preserving a file's mtime goes unwarned.

use std::collections::HashMap;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use reflect_index_schema::{INDEX_FILE, LATEST_SCHEMA_VERSION, REFLECT_DIR};

use crate::error::CliError;
use crate::hash::hash_content;
use crate::note_file::walk_notes;

/// A successfully-opened read-only index.
pub struct OpenIndex {
    pub conn: Connection,
    /// The index was written by a newer schema than this CLI knows — queries
    /// against the stable subset are attempted, but callers should warn.
    pub newer_schema: bool,
}

/// The three ways opening can go; callers decide how each degrades per command
/// (`search` needs the index; `show`/`path` fall back to scanning files).
pub enum IndexOpen {
    Opened(OpenIndex),
    /// No `.reflect/index.sqlite` on disk.
    Missing,
    /// Present but unopenable/unreadable (e.g. WAL recovery needs a writer).
    Unusable(String),
}

/// Open the graph's index strictly read-only.
pub fn open_read_only(root: &Path) -> IndexOpen {
    let file = root.join(REFLECT_DIR).join(INDEX_FILE);
    if !file.is_file() {
        return IndexOpen::Missing;
    }
    let conn = match Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(conn) => conn,
        Err(err) => return IndexOpen::Unusable(format!("could not open the index: {err}")),
    };
    if let Err(err) = conn.busy_timeout(Duration::from_millis(2000)) {
        return IndexOpen::Unusable(format!("could not configure the index connection: {err}"));
    }
    if let Err(err) = conn.pragma_update(None, "query_only", true) {
        return IndexOpen::Unusable(format!("could not configure the index connection: {err}"));
    }
    // First actual read — a WAL that needs recovery surfaces here, not at open.
    let version: i64 = match conn.query_row("PRAGMA user_version", [], |row| row.get(0)) {
        Ok(version) => version,
        Err(err) => return IndexOpen::Unusable(format!("could not read the index: {err}")),
    };
    if version == 0 {
        return IndexOpen::Unusable("the index exists but has no schema yet".to_string());
    }
    IndexOpen::Opened(OpenIndex {
        conn,
        newer_schema: version > LATEST_SCHEMA_VERSION as i64,
    })
}

/// How the index diverges from the files on disk.
#[derive(Debug, Default)]
pub struct Staleness {
    /// Files whose content hash no longer matches their indexed row.
    pub changed: usize,
    /// Files on disk with no index row.
    pub unindexed: usize,
    /// Index rows whose file is gone.
    pub deleted: usize,
}

impl Staleness {
    pub fn is_stale(&self) -> bool {
        self.total() > 0
    }

    pub fn total(&self) -> usize {
        self.changed + self.unindexed + self.deleted
    }
}

/// Compare the indexed rows against the files on disk. Only files whose mtime
/// diverges are hashed, so the check stays cheap on large graphs.
pub fn detect_staleness(conn: &Connection, root: &Path) -> Result<Staleness, CliError> {
    let mut indexed: HashMap<String, (i64, String)> = HashMap::new();
    let mut statement = conn.prepare("SELECT path, mtime, file_hash FROM notes")?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;
    for row in rows {
        let (path, mtime, file_hash) = row?;
        indexed.insert(path, (mtime, file_hash));
    }

    let mut staleness = Staleness::default();
    for note in walk_notes(root)? {
        match indexed.remove(&note.rel_path) {
            None => staleness.unindexed += 1,
            Some((mtime, file_hash)) => {
                if note.mtime_ms as i64 != mtime {
                    let changed = match std::fs::read_to_string(root.join(&note.rel_path)) {
                        Ok(content) => hash_content(&content) != file_hash,
                        Err(_) => true,
                    };
                    if changed {
                        staleness.changed += 1;
                    }
                }
            }
        }
    }
    staleness.deleted = indexed.len();
    Ok(staleness)
}
