//! Wiki link resolution over `note_keys`, `note_claims` and `links`.

use rusqlite::{Connection, OptionalExtension};

use reflect_types::{AppResult, WikiClaimMatch, WikiTitleCandidate};

fn paths(conn: &Connection, sql: &str, value: &str) -> AppResult<Vec<String>> {
    let paths = conn
        .prepare_cached(sql)?
        .query_map([value], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(paths)
}

/// The note that wins the wiki key `key`: `note_keys` holds one winner per
/// key.
pub(crate) fn resolve(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .prepare_cached("SELECT note_path FROM note_keys WHERE key = ?1 LIMIT 1")?
        .query_row([key], |row| row.get(0))
        .optional()?)
}

/// The notes that claim `key` in its strongest tier, by path. One statement
/// reads the tier and its notes, so a caller with no transaction still gets
/// a consistent answer.
pub(crate) fn claim_match(conn: &Connection, key: &str) -> AppResult<Option<WikiClaimMatch>> {
    let claims: Vec<(String, i64)> = conn
        .prepare_cached(
            "SELECT DISTINCT note_path, tier FROM note_claims
             WHERE key = ?1 AND tier = (SELECT min(tier) FROM note_claims WHERE key = ?1)
             ORDER BY note_path",
        )?
        .query_map([key], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let Some(tier) = claims.first().map(|(_, tier)| *tier) else {
        return Ok(None);
    };
    let paths = claims.into_iter().map(|(path, _)| path).collect();
    Ok(Some(WikiClaimMatch { tier, paths }))
}

/// The notes whose folded path is `path_key`, by path.
pub(crate) fn notes_by_path_key(conn: &Connection, path_key: &str) -> AppResult<Vec<String>> {
    paths(
        conn,
        "SELECT DISTINCT path FROM notes WHERE path_key = ?1 ORDER BY path",
        path_key,
    )
}

/// The notes with a link to the wiki key `target_key`, by path.
pub(crate) fn link_sources(conn: &Connection, target_key: &str) -> AppResult<Vec<String>> {
    paths(
        conn,
        "SELECT DISTINCT source_path FROM links WHERE target_key = ?1 ORDER BY source_path",
        target_key,
    )
}

/// The notes with a link to the folded path `target_path_key`, by path.
pub(crate) fn path_link_sources(
    conn: &Connection,
    target_path_key: &str,
) -> AppResult<Vec<String>> {
    paths(
        conn,
        "SELECT DISTINCT source_path FROM links WHERE target_path_key = ?1 ORDER BY source_path",
        target_path_key,
    )
}

/// The note at `path` as a suggestion candidate, with no link count.
/// Templates have none.
pub(crate) fn address_note(conn: &Connection, path: &str) -> AppResult<Option<WikiTitleCandidate>> {
    Ok(conn
        .prepare_cached(
            "SELECT path, title, title_key, daily_date, mtime FROM notes
             WHERE path = ?1 AND kind != 'template'",
        )?
        .query_row([path], |row| {
            Ok(WikiTitleCandidate {
                path: row.get(0)?,
                title: row.get(1)?,
                title_key: row.get(2)?,
                daily_date: row.get(3)?,
                mtime: row.get(4)?,
                link_count: 0,
            })
        })
        .optional()?)
}
