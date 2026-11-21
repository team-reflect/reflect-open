//! Reads of the `index_meta` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Query};

use reflect_types::AppResult;

use crate::schema::IndexMeta;
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
