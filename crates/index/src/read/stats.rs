//! Graph-level aggregates over the non-private notes.

use rusqlite::Connection;

use reflect_types::{AppResult, GraphStats, TagFacet};

/// The aggregates of the graph. `tag_limit` caps the tag facets: the most-used
/// tags win.
pub(crate) fn graph_stats(conn: &Connection, tag_limit: u32) -> AppResult<GraphStats> {
    let note_count = conn
        .prepare_cached("SELECT count(*) FROM notes WHERE kind = 'note' AND is_private = 0")?
        .query_row([], |row| row.get(0))?;
    let (daily_note_count, earliest_daily_date, latest_daily_date) = conn
        .prepare_cached(
            "SELECT count(*), min(daily_date), max(daily_date) FROM notes
             WHERE daily_date IS NOT NULL AND is_private = 0",
        )?
        .query_row([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
    // One row past the limit shows that more tags exist.
    let mut tags = conn
        .prepare_cached(
            "SELECT min(tags.tag), count(*) FROM tags
             JOIN notes ON notes.path = tags.note_path
             WHERE notes.kind = 'note' AND notes.is_private = 0
             GROUP BY tags.tag_key
             ORDER BY count(*) DESC, tags.tag_key
             LIMIT ?1",
        )?
        .query_map([i64::from(tag_limit) + 1], |row| {
            Ok(TagFacet {
                tag: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let limit = tag_limit as usize;
    let tags_truncated = tags.len() > limit;
    tags.truncate(limit);
    Ok(GraphStats {
        note_count,
        daily_note_count,
        earliest_daily_date,
        latest_daily_date,
        tags,
        tags_truncated,
    })
}
