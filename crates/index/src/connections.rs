//! Where a session's connections come from.
//!
//! The desktop and mobile shells open the index file through the shared
//! `reflect-index-schema` crate (one schema for the writer and the CLI reader).
//! A host that cannot open files itself implements [`IndexConnections`] over
//! whatever connection it owns.

#![cfg(any(feature = "native", test))]

use std::path::Path;

use rusqlite::Connection;

use reflect_types::{AppError, AppResult};

use crate::session::IndexConnections;

fn map_err(err: reflect_index_schema::SchemaError) -> AppError {
    AppError::io(err.to_string())
}

/// The file-backed connections: a migrated writer under WAL plus a second,
/// read-only connection for queries.
#[derive(Debug, Default)]
pub struct FileIndexConnections;

impl IndexConnections for FileIndexConnections {
    fn open_writer(&self, root: &Path) -> AppResult<Connection> {
        reflect_index_schema::open_index_at(root).map_err(map_err)
    }

    fn open_reader(&self, root: &Path) -> AppResult<Option<Connection>> {
        reflect_index_schema::open_index_read_only_at(root)
            .map(Some)
            .map_err(map_err)
    }
}

/// Opens an in-memory connection with sqlite-vec available (used by tests).
#[cfg(test)]
pub(crate) fn open_in_memory() -> AppResult<Connection> {
    reflect_index_schema::open_in_memory().map_err(map_err)
}

/// Open (creating if needed) and migrate `<root>/.reflect/index.sqlite`.
#[cfg(test)]
pub(crate) fn open_index_at(root: &Path) -> AppResult<Connection> {
    reflect_index_schema::open_index_at(root).map_err(map_err)
}

/// Bring the connection up to the latest schema version (no-op if current).
#[cfg(test)]
pub(crate) fn migrate(conn: &mut Connection) -> AppResult<()> {
    reflect_index_schema::migrate(conn).map_err(map_err)
}

/// Test-only: stop at schema `version`, so schema-evolution tests can stage
/// data in an older shape and assert what a later migration does with it.
#[cfg(test)]
pub(crate) fn migrate_to(conn: &mut Connection, version: usize) -> AppResult<()> {
    reflect_index_schema::migrate_to(conn, version).map_err(map_err)
}

#[cfg(test)]
pub(crate) fn validate_migrations() -> AppResult<()> {
    reflect_index_schema::validate().map_err(map_err)
}
