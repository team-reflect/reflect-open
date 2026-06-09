//! SQLite primitive layer (Plan 04).
//!
//! Connections are backed by the bundled SQLite (FTS5 compiled in) with the
//! sqlite-vec extension registered for vector search (Plan 09). The query/index
//! commands exposed to the frontend arrive in Plan 04; this module establishes
//! that both extensions are available in the Tauri Rust process.
#![allow(dead_code)] // wired into commands in Plan 04

use std::sync::Once;

use rusqlite::Connection;

static VEC_INIT: Once = Once::new();

/// Registers the sqlite-vec extension once per process, so every connection
/// opened afterwards exposes the `vec0` virtual table and `vec_*` functions.
fn register_sqlite_vec() {
    VEC_INIT.call_once(|| {
        // SAFETY: registering a statically-linked SQLite extension entry point
        // before opening connections — the documented sqlite-vec pattern.
        let rc = unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )))
        };
        // Fail fast: if registration didn't return SQLITE_OK, every later
        // connection would silently lack vec_* support.
        assert_eq!(
            rc,
            rusqlite::ffi::SQLITE_OK,
            "failed to register the sqlite-vec auto-extension (code {rc})"
        );
    });
}

/// Opens an in-memory connection with sqlite-vec available. Used by tests now,
/// and the basis for the on-disk graph index connection in Plan 04.
#[allow(dead_code)]
pub fn open_in_memory() -> rusqlite::Result<Connection> {
    register_sqlite_vec();
    Connection::open_in_memory()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_is_compiled_in() {
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(
            "CREATE VIRTUAL TABLE fts USING fts5(body);
             INSERT INTO fts(body) VALUES ('the quick brown fox');",
        )
        .expect("fts5 create/insert");
        let hits: i64 = conn
            .query_row("SELECT count(*) FROM fts WHERE fts MATCH 'quick'", [], |row| {
                row.get(0)
            })
            .expect("fts5 match");
        assert_eq!(hits, 1);
    }

    #[test]
    fn sqlite_vec_loads_and_runs_knn() {
        let conn = open_in_memory().expect("open with vec");

        let version: String = conn
            .query_row("SELECT vec_version()", [], |row| row.get(0))
            .expect("vec_version");
        assert!(!version.is_empty());

        conn.execute_batch(
            "CREATE VIRTUAL TABLE vec_items USING vec0(embedding float[4]);
             INSERT INTO vec_items(rowid, embedding) VALUES
               (1, '[1, 2, 3, 4]'),
               (2, '[9, 9, 9, 9]');",
        )
        .expect("vec0 create/insert");

        let nearest: i64 = conn
            .query_row(
                "SELECT rowid FROM vec_items \
                 WHERE embedding MATCH '[1, 2, 3, 4]' ORDER BY distance LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("vec0 knn");
        assert_eq!(nearest, 1);
    }
}
