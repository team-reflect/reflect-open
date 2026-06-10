//! Schema migrations + connection opening (incl. the sqlite-vec extension).
//!
//! `rusqlite_migration` tracks the applied version in SQLite's `user_version`
//! pragma. Append a new `M::up(include_str!(...))` (never edit a shipped one)
//! as later plans add tables (embeddings in 09, captures in 11, sync state in
//! 12).

use std::ffi::{c_char, c_int};
use std::path::Path;
use std::sync::{LazyLock, OnceLock};

use rusqlite::ffi::{sqlite3, sqlite3_api_routines};
use rusqlite::Connection;
use rusqlite_migration::{Migrations, M};

use crate::error::{AppError, AppResult};

/// Ordered schema migrations, loaded from `migrations/*.sql`.
static MIGRATIONS: LazyLock<Migrations<'static>> = LazyLock::new(|| {
    Migrations::new(vec![
        M::up(include_str!("../../migrations/0001_initial.sql")),
        M::up(include_str!("../../migrations/0002_embeddings.sql")),
        M::up(include_str!("../../migrations/0003_cosine_vectors.sql")),
        M::up(include_str!("../../migrations/0004_pinned.sql")),
        M::up(include_str!(
            "../../migrations/0005_note_list_projection.sql"
        )),
    ])
});

/// Result of the one-time sqlite-vec registration; the error message is cached so
/// every caller can surface it as an `AppError` rather than panicking.
static VEC_INIT: OnceLock<Result<(), String>> = OnceLock::new();

/// The SQLite auto-extension entry-point signature. sqlite-vec and rusqlite each
/// link their own copy of the C types, so we transmute `sqlite3_vec_init` into
/// rusqlite's matching function-pointer type.
type AutoExtensionFn =
    unsafe extern "C" fn(*mut sqlite3, *mut *mut c_char, *const sqlite3_api_routines) -> c_int;

/// Registers the sqlite-vec extension once per process, so every connection
/// opened afterwards exposes the `vec0` virtual table and `vec_*` functions.
/// Returns the cached registration result so a failure surfaces as an `AppError`
/// (e.g. from `index_open`) instead of panicking and crashing the backend.
fn register_sqlite_vec() -> AppResult<()> {
    let result = VEC_INIT.get_or_init(|| {
        // SAFETY: registering a statically-linked SQLite extension entry point
        // before opening connections — the documented sqlite-vec pattern.
        let rc = unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                *const (),
                AutoExtensionFn,
            >(
                sqlite_vec::sqlite3_vec_init as *const ()
            )))
        };
        if rc == rusqlite::ffi::SQLITE_OK {
            Ok(())
        } else {
            Err(format!(
                "failed to register the sqlite-vec auto-extension (code {rc})"
            ))
        }
    });
    result.clone().map_err(AppError::io)
}

/// Opens an in-memory connection with sqlite-vec available (used by tests).
#[allow(dead_code)]
pub(super) fn open_in_memory() -> AppResult<Connection> {
    register_sqlite_vec()?;
    Ok(Connection::open_in_memory()?)
}

/// Bring the connection up to the latest schema version (no-op if current).
pub(super) fn migrate(conn: &mut Connection) -> AppResult<()> {
    MIGRATIONS
        .to_latest(conn)
        .map_err(|err| AppError::io(format!("migration failed: {err}")))
}

/// Test-only: stop at schema `version`, so schema-evolution tests can stage
/// data in an older shape and assert what a later migration does with it.
#[cfg(test)]
pub(super) fn migrate_to(conn: &mut Connection, version: usize) -> AppResult<()> {
    MIGRATIONS
        .to_version(conn, version)
        .map_err(|err| AppError::io(format!("migration to {version} failed: {err}")))
}

/// Open (creating if needed) and migrate `<root>/.reflect/index.sqlite`.
pub(super) fn open_index_at(root: &Path) -> AppResult<Connection> {
    register_sqlite_vec()?;
    let dir = root.join(".reflect");
    std::fs::create_dir_all(&dir)?;
    let mut conn = Connection::open(dir.join("index.sqlite"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
    migrate(&mut conn)?;
    Ok(conn)
}

#[cfg(test)]
pub(super) fn validate_migrations() -> AppResult<()> {
    // Validation replays the migrations on its own connection; vec0 must be
    // registered first (the auto-extension is process-global but not innate —
    // without this the test is order-dependent on whoever registers first).
    register_sqlite_vec()?;
    MIGRATIONS
        .validate()
        .map_err(|err| AppError::io(format!("invalid migration set: {err}")))
}
