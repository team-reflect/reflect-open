//! Reads of the `assets` table.

use rusqlite::Connection;

use reflect_types::AppResult;

use super::notes::json_list;

/// The notes that reference any of `asset_paths`.
pub(crate) fn note_paths(conn: &Connection, asset_paths: &[String]) -> AppResult<Vec<String>> {
    let paths = conn
        .prepare_cached(
            "SELECT DISTINCT note_path FROM assets
             WHERE asset_path IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([json_list(asset_paths)?], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(paths)
}
