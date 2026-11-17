//! Reads of the `index_meta` table.

use rusqlite::{Connection, OptionalExtension};

use reflect_types::AppResult;

/// The value of one `index_meta` key.
pub(crate) fn meta(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT value FROM index_meta WHERE key = ?1")?
        .query_row([key], |row| row.get(0))
        .optional()?)
}
