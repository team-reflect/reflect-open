//! Reads of the `backlinks` view: the links that point at a note.

use std::collections::HashMap;

use rusqlite::{Connection, ToSql, params};

use reflect_types::{
    AppError, AppResult, Backlink, BacklinkPage, BacklinkSource, BacklinkSourceCursor,
};

/// The recency of a source note: its daily date, else its last change, in
/// epoch ms.
const RECENCY: &str = "coalesce(strftime('%s', notes.daily_date) * 1000, notes.updated_at)";

/// Every link that points at the note at `path`, by source path.
pub(crate) fn backlinks(conn: &Connection, path: &str) -> AppResult<Vec<Backlink>> {
    let links = conn
        .prepare_cached(
            "SELECT source_path, target_raw, alias, pos_from, pos_to FROM backlinks
             WHERE target_path = ?1
             ORDER BY source_path",
        )?
        .query_map([path], |row| {
            Ok(Backlink {
                source_path: row.get(0)?,
                target_raw: row.get(1)?,
                alias: row.get(2)?,
                pos_from: row.get(3)?,
                pos_to: row.get(4)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(links)
}

/// One page of the sources that link to the note at `path`: most recent
/// first, then by path, at most `limit`, after `cursor`. Each source carries
/// the positions of its links. A `limit` below 1 is an error.
pub(crate) fn page(
    conn: &Connection,
    path: &str,
    limit: i64,
    cursor: Option<&BacklinkSourceCursor>,
) -> AppResult<BacklinkPage> {
    if limit <= 0 {
        return Err(AppError::parse("the backlink page limit must be positive"));
    }
    let target_keys = conn
        .prepare_cached("SELECT key FROM note_keys WHERE note_path = ?1 AND key IS NOT NULL")?
        .query_map([path], |row| row.get(0))?
        .collect::<Result<_, _>>()?;

    // Sources strictly after the cursor in (recency DESC, path) order.
    let after = "(?2 IS NULL OR recency < ?2 OR (recency = ?2 AND source_path > ?3))";
    let cursor_recency = cursor.map(|cursor| cursor.recency_ms);
    let cursor_path = cursor.map(|cursor| cursor.source_path.as_str());

    // One row past the limit shows that another page exists.
    let mut candidates: Vec<(String, String, i64)> = conn
        .prepare_cached(&format!(
            "SELECT DISTINCT source_path, source_title, recency FROM (
               SELECT backlinks.source_path AS source_path, notes.title AS source_title,
                      {RECENCY} AS recency
               FROM backlinks
               JOIN notes ON notes.path = backlinks.source_path
               WHERE backlinks.target_path = ?1
             )
             WHERE {after}
             ORDER BY recency DESC, source_path
             LIMIT ?4"
        ))?
        .query_map(
            params![path, cursor_recency, cursor_path, limit.saturating_add(1)],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?
        .collect::<Result<_, _>>()?;
    let indexed_link_count = conn
        .prepare_cached(
            "SELECT count(*) FROM backlinks
             JOIN notes ON notes.path = backlinks.source_path
             WHERE backlinks.target_path = ?1",
        )?
        .query_row([path], |row| row.get(0))?;

    let has_more = i64::try_from(candidates.len()).is_ok_and(|found| found > limit);
    candidates.truncate(usize::try_from(limit).unwrap_or(usize::MAX));
    let Some((last_path, _, last_recency)) = candidates.last().cloned() else {
        return Ok(BacklinkPage {
            sources: Vec::new(),
            next_cursor: None,
            indexed_link_count,
            target_keys,
        });
    };

    // The link positions of the whole source range of the page, in one query.
    let range: [&dyn ToSql; 5] = [
        &path,
        &cursor_recency,
        &cursor_path,
        &last_recency,
        &last_path,
    ];
    let positions: Vec<(String, i64)> = conn
        .prepare_cached(&format!(
            "SELECT source_path, pos_from FROM (
               SELECT backlinks.source_path AS source_path, backlinks.pos_from AS pos_from,
                      {RECENCY} AS recency
               FROM backlinks
               JOIN notes ON notes.path = backlinks.source_path
               WHERE backlinks.target_path = ?1
             )
             WHERE {after}
               AND (recency > ?4 OR (recency = ?4 AND source_path <= ?5))
             ORDER BY recency DESC, source_path, pos_from"
        ))?
        .query_map(range, |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let mut positions_by_source: HashMap<String, Vec<i64>> = HashMap::new();
    for (source_path, pos_from) in positions {
        positions_by_source
            .entry(source_path)
            .or_default()
            .push(pos_from);
    }

    let sources = candidates
        .into_iter()
        .map(|(source_path, source_title, _)| BacklinkSource {
            positions: positions_by_source.remove(&source_path).unwrap_or_default(),
            source_path,
            source_title,
        })
        .collect();
    Ok(BacklinkPage {
        sources,
        next_cursor: has_more.then_some(BacklinkSourceCursor {
            recency_ms: last_recency,
            source_path: last_path,
        }),
        indexed_link_count,
        target_keys,
    })
}
