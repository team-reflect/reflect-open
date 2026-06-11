//! Thin adapter over the shared `reflect-index-schema` crate, which owns the
//! migrations + sqlite-vec registration (shared with the `reflect` CLI so the
//! schema can never skew between writer and reader). This module only maps
//! errors into the app's [`AppError`] contract.

use std::path::Path;

use rusqlite::Connection;

use crate::error::{AppError, AppResult};

fn map_err(err: reflect_index_schema::SchemaError) -> AppError {
    AppError::io(err.to_string())
}

/// Open (creating if needed) and migrate `<root>/.reflect/index.sqlite`.
pub(super) fn open_index_at(root: &Path) -> AppResult<Connection> {
    reflect_index_schema::open_index_at(root).map_err(map_err)
}

/// Opens an in-memory connection with sqlite-vec available (used by tests).
#[cfg(test)]
pub(super) fn open_in_memory() -> AppResult<Connection> {
    reflect_index_schema::open_in_memory().map_err(map_err)
}

/// Bring the connection up to the latest schema version (no-op if current).
#[cfg(test)]
pub(super) fn migrate(conn: &mut Connection) -> AppResult<()> {
    reflect_index_schema::migrate(conn).map_err(map_err)
}

/// Test-only: stop at schema `version`, so schema-evolution tests can stage
/// data in an older shape and assert what a later migration does with it.
#[cfg(test)]
pub(super) fn migrate_to(conn: &mut Connection, version: usize) -> AppResult<()> {
    reflect_index_schema::migrate_to(conn, version).map_err(map_err)
}

#[cfg(test)]
pub(super) fn validate_migrations() -> AppResult<()> {
    reflect_index_schema::validate().map_err(map_err)
}
