//! Reads of the `index_meta` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Query};

use reflect_types::{AppError, AppResult};

use crate::schema::{COMMIT_SEQ_KEY, IndexMeta};
use crate::sql;

/// The value of one `index_meta` key.
pub(crate) fn meta(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    sql::query_optional(
        conn,
        Query::select()
            .column(IndexMeta::Value)
            .from(IndexMeta::Table)
            .and_where(Expr::col(IndexMeta::Key).eq(key)),
        |row| row.get(0),
    )
}

/// The number of index write transactions committed to this database file.
pub(crate) fn commit_seq(conn: &Connection) -> AppResult<u64> {
    match meta(conn, COMMIT_SEQ_KEY)? {
        Some(value) => value
            .parse()
            .map_err(|err| AppError::io(format!("invalid {COMMIT_SEQ_KEY}: {err}"))),
        None => Ok(0),
    }
}
