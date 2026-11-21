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
//! Then decide [`MIN_COMPATIBLE_SCHEMA_VERSION`].
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
pub const LATEST_SCHEMA_VERSION: usize = 23;

/// The oldest schema version whose app can still use an index at
/// [`LATEST_SCHEMA_VERSION`]. Reflect and Reflect Beta share one index; an older
/// app uses a newer one unchanged when this allows it.
///
/// Keep it for an additive migration: new tables, indexes, or columns that an
/// older app's inserts can omit. Set it to the new version for anything else.
/// Data the indexer fills needs a `PROJECTION_VERSION` bump; a new derived
/// table needs `ON DELETE CASCADE` to `notes(path)`.
pub const MIN_COMPATIBLE_SCHEMA_VERSION: usize = 23;

/// The `index_meta` key holding [`MIN_COMPATIBLE_SCHEMA_VERSION`].
const MIN_COMPATIBLE_SCHEMA_KEY: &str = "min_compatible_schema";

/// The `index_meta` key holding the TS-owned projection version (the rows'
/// derivation version, distinct from the schema version above).
pub const PROJECTION_VERSION_KEY: &str = "projection_version";

/// Applies the settings that every connection to the index uses.
pub fn configure_connection(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    use rusqlite::config::DbConfig;
    // A double-quoted name that is not a column is an error. By default
    // SQLite reads it as a string, so a wrong column name gives wrong rows.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
    // SQL cannot write the shadow tables or `sqlite_master`.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
    // The schema of the file cannot call functions with side effects.
    conn.set_db_config(DbConfig::SQLITE_DBCONFIG_TRUSTED_SCHEMA, false)?;
    Ok(())
}

/// Reads the index's schema version from `PRAGMA user_version`.
pub fn read_user_version(conn: &rusqlite::Connection) -> rusqlite::Result<usize> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    // Negative values (never written by migrations) read as 0.
    Ok(usize::try_from(version).unwrap_or(0))
}

/// The stamped [`MIN_COMPATIBLE_SCHEMA_VERSION`], or `None` when unstamped.
fn read_min_compatible_schema(conn: &rusqlite::Connection) -> rusqlite::Result<Option<usize>> {
    use rusqlite::OptionalExtension;
    let value: Option<String> = conn
        .query_row(
            "SELECT value FROM index_meta WHERE key = ?1",
            [MIN_COMPATIBLE_SCHEMA_KEY],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value.and_then(|value| value.parse().ok()))
}

/// Whether this app can use the index: it is not newer than
/// [`LATEST_SCHEMA_VERSION`], or its stamp allows this app.
pub fn is_compatible_schema(conn: &rusqlite::Connection) -> rusqlite::Result<bool> {
    if read_user_version(conn)? <= LATEST_SCHEMA_VERSION {
        return Ok(true);
    }
    let min_compatible = read_min_compatible_schema(conn)?;
    Ok(min_compatible.is_some_and(|min| min <= LATEST_SCHEMA_VERSION))
}

#[cfg(feature = "vec")]
mod schema {
    use std::ffi::{c_char, c_int};
    use std::fmt;
    #[cfg(not(target_family = "wasm"))]
    use std::path::Path;
    use std::sync::{LazyLock, OnceLock};

    use rusqlite::ffi::{sqlite3, sqlite3_api_routines};
    use rusqlite::{Connection, Transaction};
    use rusqlite_migration::{HookResult, M, MigrationDefinitionError, Migrations};

    const UPSERT_STAMP: &str = "INSERT INTO index_meta(key, value) VALUES (?1, ?2) \
         ON CONFLICT(key) DO UPDATE SET value = excluded.value";

    /// A migration that also writes the stamp, so it commits with the new
    /// `user_version`.
    fn up(sql: &'static str) -> M<'static> {
        M::up_with_hook(sql, |tx: &Transaction| -> HookResult {
            let stamp = crate::MIN_COMPATIBLE_SCHEMA_VERSION.to_string();
            tx.execute(UPSERT_STAMP, (crate::MIN_COMPATIBLE_SCHEMA_KEY, stamp))?;
            Ok(())
        })
    }

    /// Ordered schema migrations, loaded from `migrations/*.sql`.
    static MIGRATIONS: LazyLock<Migrations<'static>> = LazyLock::new(|| {
        Migrations::new(vec![
            up(include_str!("../migrations/0001_initial.sql")),
            up(include_str!("../migrations/0002_embeddings.sql")),
            up(include_str!("../migrations/0003_cosine_vectors.sql")),
            up(include_str!("../migrations/0004_pinned.sql")),
            up(include_str!("../migrations/0005_note_list_projection.sql")),
            up(include_str!("../migrations/0006_conflicts.sql")),
            up(include_str!("../migrations/0007_note_id_index.sql")),
            up(include_str!("../migrations/0008_chat.sql")),
            up(include_str!("../migrations/0009_gist.sql")),
            up(include_str!("../migrations/0010_tag_search_indexes.sql")),
            up(include_str!("../migrations/0011_tasks.sql")),
            up(include_str!("../migrations/0012_task_due_date.sql")),
            up(include_str!("../migrations/0013_perf_indexes.sql")),
            up(include_str!("../migrations/0014_note_kind.sql")),
            up(include_str!("../migrations/0015_note_kind_invariant.sql")),
            up(include_str!("../migrations/0016_note_emails.sql")),
            up(include_str!("../migrations/0017_task_breadcrumbs.sql")),
            up(include_str!("../migrations/0018_note_key_precedence.sql")),
            up(include_str!("../migrations/0019_note_claims.sql")),
            up(include_str!(
                "../migrations/0020_backlink_name_fallback.sql"
            )),
            up(include_str!("../migrations/0021_note_has_content.sql")),
            up(include_str!("../migrations/0022_drop_note_text.sql")),
            up(include_str!("../migrations/0023_task_ast_path.sql")),
        ])
    });

    /// Why a schema operation failed; `Display` carries the full story.
    #[derive(Debug)]
    pub enum SchemaError {
        Sqlite(rusqlite::Error),
        Migration(String),
        Io(std::io::Error),
        VecRegistration(String),
        /// The index comes from a newer app whose schema this app cannot use.
        TooNew {
            found: usize,
            supported: usize,
        },
    }

    impl fmt::Display for SchemaError {
        fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            match self {
                SchemaError::Sqlite(err) => write!(formatter, "{err}"),
                SchemaError::Migration(message) => write!(formatter, "migration failed: {message}"),
                SchemaError::Io(err) => write!(formatter, "{err}"),
                SchemaError::VecRegistration(message) => write!(formatter, "{message}"),
                SchemaError::TooNew { found, supported } => write!(
                    formatter,
                    "index schema {found} is newer than this app supports ({supported})"
                ),
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
                >(vec_init())))
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

    #[cfg(not(target_family = "wasm"))]
    fn vec_init() -> *const () {
        sqlite_vec::sqlite3_vec_init as *const ()
    }

    #[cfg(target_family = "wasm")]
    fn vec_init() -> *const () {
        sqlite_wasm_vec::sqlite3_vec_init as *const ()
    }

    /// Opens an in-memory connection with sqlite-vec available.
    pub fn open_in_memory() -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        let conn = Connection::open_in_memory()?;
        super::configure_connection(&conn)?;
        Ok(conn)
    }

    /// Migrates to the latest schema; each migration stamps
    /// [`MIN_COMPATIBLE_SCHEMA_VERSION`]. A newer index is never written: it is
    /// used unchanged when its stamp allows this app, else [`SchemaError::TooNew`].
    ///
    /// [`MIN_COMPATIBLE_SCHEMA_VERSION`]: crate::MIN_COMPATIBLE_SCHEMA_VERSION
    pub fn migrate(conn: &mut Connection) -> Result<(), SchemaError> {
        match MIGRATIONS.to_latest(conn) {
            Ok(()) => {}
            Err(rusqlite_migration::Error::MigrationDefinition(
                MigrationDefinitionError::DatabaseTooFarAhead,
            )) => {
                if crate::is_compatible_schema(conn)? {
                    return Ok(());
                }
                return Err(SchemaError::TooNew {
                    found: crate::read_user_version(conn)?,
                    supported: crate::LATEST_SCHEMA_VERSION,
                });
            }
            Err(err) => return Err(SchemaError::Migration(err.to_string())),
        }
        // An index that was already current may predate the stamp. The guard
        // skips it when a newer app migrated it since `to_latest`.
        let stamp = crate::MIN_COMPATIBLE_SCHEMA_VERSION;
        if crate::read_min_compatible_schema(conn)? != Some(stamp) {
            conn.execute(
                "INSERT INTO index_meta(key, value) \
                 SELECT ?1, ?2 FROM pragma_user_version WHERE user_version = ?3 \
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (
                    crate::MIN_COMPATIBLE_SCHEMA_KEY,
                    stamp.to_string(),
                    crate::LATEST_SCHEMA_VERSION as i64,
                ),
            )?;
        }
        Ok(())
    }

    /// Stop at schema `version`, so schema-evolution tests can stage data in an
    /// older shape and assert what a later migration does with it.
    pub fn migrate_to(conn: &mut Connection, version: usize) -> Result<(), SchemaError> {
        MIGRATIONS
            .to_version(conn, version)
            .map_err(|err| SchemaError::Migration(format!("to version {version}: {err}")))
    }

    /// Open (creating if needed) and migrate `<root>/.reflect/index.sqlite`.
    #[cfg(not(target_family = "wasm"))]
    pub fn open_index_at(root: &Path) -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        let dir = root.join(super::REFLECT_DIR);
        std::fs::create_dir_all(&dir)?;
        let mut conn = Connection::open(dir.join(super::INDEX_FILE))?;
        super::configure_connection(&conn)?;
        // Another PROCESS can hold this database too — a second app flavor on
        // the same graph, or the `reflect` CLI (which sets its own timeout).
        // Wait briefly for a cross-process lock to clear instead of failing
        // writes instantly with SQLITE_BUSY ("database is locked").
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;
        migrate(&mut conn)?;
        Ok(conn)
    }

    /// Open `<root>/.reflect/index.sqlite` **read-only** (no create, no
    /// migrate) — a second connection for query traffic, so a long read never
    /// holds the writer's lock. WAL readers see the last committed state, and
    /// the writer connection (opened first via [`open_index_at`]) owns the
    /// file's existence and schema.
    #[cfg(not(target_family = "wasm"))]
    pub fn open_index_read_only_at(root: &Path) -> Result<Connection, SchemaError> {
        register_sqlite_vec()?;
        let path = root.join(super::REFLECT_DIR).join(super::INDEX_FILE);
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                | rusqlite::OpenFlags::SQLITE_OPEN_URI
                | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        super::configure_connection(&conn)?;
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
        fn a_quoted_name_that_is_no_column_is_an_error() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            let error = conn.prepare(r#"SELECT "titel" FROM "notes""#).unwrap_err();
            assert!(error.to_string().contains("no such column"), "{error}");
        }

        #[test]
        fn a_quoted_name_in_an_index_that_is_no_column_is_an_error() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            let error = conn
                .execute_batch(r#"CREATE INDEX probe ON notes(path) WHERE kind = "note""#)
                .unwrap_err();
            assert!(error.to_string().contains("no such column"), "{error}");
        }

        #[test]
        fn a_write_to_a_shadow_table_is_an_error() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            let error = conn
                .execute_batch("DELETE FROM search_fts_data")
                .unwrap_err();
            assert!(error.to_string().contains("may not be modified"), "{error}");
        }

        fn set_user_version(conn: &Connection, version: usize) {
            conn.pragma_update(None, "user_version", version as i64)
                .unwrap();
        }

        fn set_min_compatible(conn: &Connection, version: usize) {
            conn.execute(
                UPSERT_STAMP,
                (crate::MIN_COMPATIBLE_SCHEMA_KEY, version.to_string()),
            )
            .unwrap();
        }

        fn delete_min_compatible(conn: &Connection) {
            conn.execute(
                "DELETE FROM index_meta WHERE key = ?1",
                [crate::MIN_COMPATIBLE_SCHEMA_KEY],
            )
            .unwrap();
        }

        #[test]
        fn a_current_index_without_a_stamp_gets_one() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            assert_eq!(
                crate::read_min_compatible_schema(&conn).unwrap(),
                Some(crate::MIN_COMPATIBLE_SCHEMA_VERSION)
            );
            delete_min_compatible(&conn);

            migrate(&mut conn).unwrap();

            assert_eq!(
                crate::read_min_compatible_schema(&conn).unwrap(),
                Some(crate::MIN_COMPATIBLE_SCHEMA_VERSION)
            );
        }

        #[test]
        fn an_upgrade_replaces_an_older_stamp() {
            let mut conn = open_in_memory().unwrap();
            migrate_to(&mut conn, crate::LATEST_SCHEMA_VERSION - 1).unwrap();
            set_min_compatible(&conn, 1);

            migrate(&mut conn).unwrap();

            assert_eq!(
                crate::read_min_compatible_schema(&conn).unwrap(),
                Some(crate::MIN_COMPATIBLE_SCHEMA_VERSION)
            );
        }

        #[test]
        fn a_newer_compatible_index_opens_without_migrating() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            let newer = crate::LATEST_SCHEMA_VERSION + 1;
            set_user_version(&conn, newer);
            set_min_compatible(&conn, crate::LATEST_SCHEMA_VERSION);

            migrate(&mut conn).unwrap();

            assert_eq!(crate::read_user_version(&conn).unwrap(), newer);
        }

        #[test]
        fn a_newer_incompatible_index_is_too_new() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            let newer = crate::LATEST_SCHEMA_VERSION + 1;
            set_user_version(&conn, newer);
            set_min_compatible(&conn, newer);

            let error = migrate(&mut conn).unwrap_err();

            assert!(
                matches!(error, SchemaError::TooNew { found, supported } if found == newer && supported == crate::LATEST_SCHEMA_VERSION),
                "{error}"
            );
            assert_eq!(crate::read_user_version(&conn).unwrap(), newer);
        }

        #[test]
        fn a_newer_index_without_a_stamp_is_too_new() {
            let mut conn = open_in_memory().unwrap();
            migrate(&mut conn).unwrap();
            delete_min_compatible(&conn);
            set_user_version(&conn, crate::LATEST_SCHEMA_VERSION + 1);

            let error = migrate(&mut conn).unwrap_err();

            assert!(matches!(error, SchemaError::TooNew { .. }), "{error}");
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
pub use schema::{SchemaError, migrate, migrate_to, open_in_memory, register_sqlite_vec, validate};
#[cfg(all(feature = "vec", not(target_family = "wasm")))]
pub use schema::{open_index_at, open_index_read_only_at};
