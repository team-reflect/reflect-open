//! Reads of the `assets` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Query};

use reflect_types::AppResult;

use crate::schema::Assets;
use crate::sql;

/// The notes that reference any of `asset_paths`.
pub(crate) fn note_paths(conn: &Connection, asset_paths: &[String]) -> AppResult<Vec<String>> {
    sql::query(
        conn,
        Query::select()
            .distinct()
            .column(Assets::NotePath)
            .from(Assets::Table)
            .and_where(Expr::col(Assets::AssetPath).in_subquery(sql::json_values(asset_paths)?)),
        |row| row.get(0),
    )
}
