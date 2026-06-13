//! Shared schema + migrations for `<graph>/.reflect/index.sqlite` (Plan 04/14).
//!
//! The desktop app (writer) and the `reflect` CLI (read-only) both depend on
//! this crate, so the schema can never skew between them. Everything that
//! creates or migrates the schema sits behind the `vec` feature — the vec0
//! virtual tables (Plan 09) require the sqlite-vec extension. Read-only
//! consumers build with `default-features = false` and get just the constants.
//!
//! `rusqlite_migration` tracks the applied version in SQLite's `user_version`
//! pragma. Append a new `M::up(include_str!(...))` (never edit a shipped one)
//! as later plans add tables — and bump [`LATEST_SCHEMA_VERSION`] with it.
//!
//! Almost every table is a rebuildable projection of the markdown — except
//! the `chat_*` tables (0008), which hold durable chat history. Wipe-style
//! migrations (0004, 0006) and `index_clear` must never touch them.

/// Directory inside a graph that holds the index (and marks a dir as a graph).
pub const REFLECT_DIR: &str = ".reflect";

/// The index database's filename inside [`REFLECT_DIR`].
pub const INDEX_FILE: &str = "index.sqlite";

/// `user_version` after every migration has run. Read-only consumers compare
/// this against `PRAGMA user_version` to detect an index written by a newer
/// (or older) app than they were built for.
pub const LATEST_SCHEMA_VERSION: usize = 9;

/// The `index_meta` key holding the TS-owned projection version (the rows'
/// derivation version, distinct from the schema version above).
pub const PROJECTION_VERSION_KEY: &str = "projection_version";

#[cfg(feature = "vec")]
mod schema {
    use std::ffi::{c_char, c_int};
    use std::fmt;
    use std::path::Path;
    use std::sync::{LazyLock, OnceLock};

    use rusqlite::ffi::{sqlite3, sqlite3_api_routines};
    use rusqlite::Connection;
    use rusqlite_migration::{Migrations, M};

    /// Ordered schema migrations, loaded from `migrations/*.sql`.
    static MIGRATIONS: LazyLock<Migrations<'static>> = LazyLock::new(|| {
        Migrations::new(vec![
            M::up(include_str!("../migrations/0001_initial.sql")),
            M::up(include_str!("../migrations/0002_embeddings.sql")),
            M::up(include_str!("../migrations/0003_cosine_vectors.sql")),
            M::up(include_str!("../migrations/0004_pinned.sql")),
            M::up(include_str!("../migrations/0005_note_list_projection.sql")),
            M::up(include_str!("../migrations/0006_conflicts.sql")),
            M::up(include_str!("../migrations/0007_note_id_index.sql")),
            M::up(include_str!("../migrations/0008_chat.sql")),
            M::up(include_str!("../migrations/0009_gist.sql")),
        ])
    });

    /// Why a schema operation failed; `Display` carries the full story.
    #[derive(Debug)]
    pub enum SchemaError {
        Sqlite(rusqlite::Error),
        Migration(String),
        Io(std::io::Error),
        VecRegistration(String),
    }

    impl fmt::Display for SchemaError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                SchemaError::Sqlite(err) => write!(formatter, "{err}"),
                SchemaError::Migration(message) => write!(formatter, "migration failed: {message}"),
                SchemaError::Io(err) => write!(formatter, "{err}"),
                SchemaError::VecRegistration(message) => write!(formatter, "{message}"),
            }
        }
    }

    impl std::error::Error for SchemaError {}

    impl From<rusqlite::Error> for SchemaError {
        fn from(err: rusqlite::Error) -> Self {
            SchemaError::Sqlite(err)
        }
    }

    impl From<std::io::Error> for SchemaError {
        fn from(err: std::io::Error) -> Self {
            SchemaError::Io(err)
        }
    }

    /// Result of the one-time sqlite-vec registration; the error message is
    /// cached so every caller surfaces it instead of panicking.
    static VEC_INIT: OnceLock<Result<(), String>> = OnceLock::new();

    /// The SQLite auto-extension entry-point signature. sqlite-vec and rusqlite
    /// each link their own copy of the C types, so we transmute
    /// `sqlite3_vec_init` into rusqlite's matching function-pointer type.
    type AutoExtensionFn =
        unsafe extern "C" fn(*mut sqlite3, *mut *mut c_char, *const sqlite3_api_routines) -> c_int;

    /// Registers the sqlite-vec extension once per process, so every connection
    /// opened afterwards exposes the `vec0` virtual table and `vec_*` functions.
    pub fn register_sqlite_vec() -> Result<(), SchemaError> {
        let result = VEC_INIT.get_or_init(|| {
            // SAFETY: registering a statically-linked SQLite extension entry
            // point before opening connections — the documented sqlite-vec pattern.
            let rc = unsafe {
                rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
                    *const (),
                    AutoExtensionFn,
                >(
                    sqlite_vec::sqlite3_vec_init as *const (),
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
        result.clone().map_err(SchemaError::VecRegistration)
    }

    /// Opens an in-memory connection with sqlite-vec available (used by tests).
    pub fn open_in_memory() -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        Ok(Connection::open_in_memory()?)
    }

    /// Bring the connection up to the latest schema version (no-op if current).
    pub fn migrate(conn: &mut Connection) -> Result<(), SchemaError> {
        MIGRATIONS
            .to_latest(conn)
            .map_err(|err| SchemaError::Migration(err.to_string()))
    }

    /// Stop at schema `version`, so schema-evolution tests can stage data in an
    /// older shape and assert what a later migration does with it.
    pub fn migrate_to(conn: &mut Connection, version: usize) -> Result<(), SchemaError> {
        MIGRATIONS
            .to_version(conn, version)
            .map_err(|err| SchemaError::Migration(format!("to version {version}: {err}")))
    }

    /// Open (creating if needed) and migrate `<root>/.reflect/index.sqlite`.
    pub fn open_index_at(root: &Path) -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        let dir = root.join(super::REFLECT_DIR);
        std::fs::create_dir_all(&dir)?;
        let mut conn = Connection::open(dir.join(super::INDEX_FILE))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        migrate(&mut conn)?;
        Ok(conn)
    }

    /// Check the migration set itself (each `up` parses and applies in order).
    pub fn validate() -> Result<(), SchemaError> {
        // Validation replays the migrations on its own connection; vec0 must be
        // registered first (the auto-extension is process-global but not innate
        // — without this the check is order-dependent on who registers first).
        register_sqlite_vec()?;
        MIGRATIONS
            .validate()
            .map_err(|err| SchemaError::Migration(format!("invalid migration set: {err}")))
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn migrations_are_valid() {
            validate().unwrap();
        }

        #[test]
        fn latest_schema_version_matches_migrations() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            let version: i64 = conn
                .query_row("PRAGMA user_version", [], |row| row.get(0))
                .unwrap();
            assert_eq!(version, crate::LATEST_SCHEMA_VERSION as i64);
        }
    }
}

#[cfg(feature = "vec")]
pub use schema::{
    migrate, migrate_to, open_in_memory, open_index_at, register_sqlite_vec, validate, SchemaError,
};
