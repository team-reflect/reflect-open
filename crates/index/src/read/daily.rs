//! Reads of the daily notes.

use rusqlite::{Connection, params};

use reflect_types::{AppResult, DailyNoteRow};

/// The dates in `start..=end` whose daily note has content, ascending.
pub(crate) fn dates_in_range(conn: &Connection, start: &str, end: &str) -> AppResult<Vec<String>> {
    let dates = conn
        .prepare_cached(
            "SELECT daily_date FROM notes
             WHERE daily_date IS NOT NULL AND daily_date >= ?1 AND daily_date <= ?2
               AND has_content = 1
             ORDER BY daily_date",
        )?
        .query_map(params![start, end], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(dates)
}

/// The non-private daily notes in `start..=end`, newest first, at most
/// `limit`.
pub(crate) fn notes_in_range(
    conn: &Connection,
    start: &str,
    end: &str,
    limit: u32,
) -> AppResult<Vec<DailyNoteRow>> {
    let notes = conn
        .prepare_cached(
            "SELECT path, title, daily_date, preview, mtime, is_private FROM notes
             WHERE daily_date IS NOT NULL AND daily_date >= ?1 AND daily_date <= ?2
               AND is_private = 0
             ORDER BY daily_date DESC
             LIMIT ?3",
        )?
        .query_map(params![start, end, limit], |row| {
            Ok(DailyNoteRow {
                path: row.get(0)?,
                title: row.get(1)?,
                daily_date: row.get(2)?,
                preview: row.get(3)?,
                mtime: row.get(4)?,
                is_private: row.get(5)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(notes)
}
