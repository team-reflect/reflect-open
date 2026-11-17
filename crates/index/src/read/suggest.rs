//! The candidates of the tag and wiki link suggestions.

use rusqlite::{Connection, Row, params};

use reflect_types::{
    AppResult, TagFacet, WikiAliasCandidate, WikiCandidates, WikiKeyWinner, WikiTitleCandidate,
    WikiWinningAlias,
};

use super::notes::json_list;
use crate::text::fts::build_fts_title_prefix_match;

/// The size of each candidate pool. Ranking happens in the frontend.
const WIKI_CANDIDATE_LIMIT: u32 = 200;

/// The number of links that point at a key the note claims.
const LINK_COUNT: &str = "(SELECT count(*) FROM note_claims
       JOIN links ON links.target_key = note_claims.key
       WHERE note_claims.note_path = notes.path)";

/// A `LIKE` pattern that matches `key` anywhere, for `ESCAPE '\'`.
fn like_contains(key: &str) -> String {
    let mut pattern = String::with_capacity(key.len() + 2);
    pattern.push('%');
    for character in key.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    pattern
}

/// The most used tags whose key contains `tag_key` (every tag when it is
/// empty), most used first, at most `limit`. Templates do not count.
pub(crate) fn tags(conn: &Connection, tag_key: &str, limit: u32) -> AppResult<Vec<TagFacet>> {
    let facet = |row: &Row<'_>| {
        Ok(TagFacet {
            tag: row.get(0)?,
            count: row.get(1)?,
        })
    };
    let facets = if tag_key.is_empty() {
        conn.prepare_cached(
            "SELECT min(tags.tag), count(*) FROM tags
             JOIN notes ON notes.path = tags.note_path
             WHERE notes.kind != 'template'
             GROUP BY tags.tag_key
             ORDER BY count(*) DESC, min(tags.tag)
             LIMIT ?1",
        )?
        .query_map([limit], facet)?
        .collect::<Result<_, _>>()?
    } else {
        conn.prepare_cached(
            "SELECT min(tags.tag), count(*) FROM tags
             JOIN notes ON notes.path = tags.note_path
             WHERE notes.kind != 'template' AND tags.tag_key LIKE ?1 ESCAPE '\\'
             GROUP BY tags.tag_key
             ORDER BY count(*) DESC, min(tags.tag)
             LIMIT ?2",
        )?
        .query_map(params![like_contains(tag_key), limit], facet)?
        .collect::<Result<_, _>>()?
    };
    Ok(facets)
}

fn title_candidate(row: &Row<'_>) -> rusqlite::Result<WikiTitleCandidate> {
    Ok(WikiTitleCandidate {
        path: row.get(0)?,
        title: row.get(1)?,
        title_key: row.get(2)?,
        daily_date: row.get(3)?,
        mtime: row.get(4)?,
        link_count: row.get(5)?,
    })
}

/// The notes whose title or alias matches the folded wiki key `key`.
///
/// The pool is cut by usage before recency: a much-linked note stays in it
/// however long ago its file changed, and an exact hit is always kept. The
/// search index also admits titles that differ only in accents; those rank
/// below spelled hits. An empty key lists notes only: days come from the date
/// generator of the frontend.
pub(crate) fn wiki_candidates(conn: &Connection, key: &str) -> AppResult<WikiCandidates> {
    let contains = like_contains(key);
    let select = format!(
        "SELECT path, title, title_key, daily_date, mtime, {LINK_COUNT} AS link_count FROM notes
         WHERE kind != 'template'"
    );
    let order = "ORDER BY title_key = ?1 DESC, (title_key LIKE ?2 ESCAPE '\\') DESC,
                 link_count DESC, mtime DESC
                 LIMIT ?3";
    let titles = if key.is_empty() {
        conn.prepare_cached(&format!("{select} AND daily_date IS NULL {order}"))?
            .query_map(
                params![key, contains, WIKI_CANDIDATE_LIMIT],
                title_candidate,
            )?
            .collect::<Result<_, _>>()?
    } else if let Some(fts_match) = build_fts_title_prefix_match(key) {
        conn.prepare_cached(&format!(
            "{select} AND (title_key LIKE ?2 ESCAPE '\\'
               OR path IN (SELECT path FROM search_fts WHERE search_fts MATCH ?4))
             {order}"
        ))?
        .query_map(
            params![key, contains, WIKI_CANDIDATE_LIMIT, fts_match],
            title_candidate,
        )?
        .collect::<Result<_, _>>()?
    } else {
        conn.prepare_cached(&format!(
            "{select} AND title_key LIKE ?2 ESCAPE '\\' {order}"
        ))?
        .query_map(
            params![key, contains, WIKI_CANDIDATE_LIMIT],
            title_candidate,
        )?
        .collect::<Result<_, _>>()?
    };

    let aliases = if key.is_empty() {
        Vec::new()
    } else {
        conn.prepare_cached(&format!(
            "SELECT notes.path, notes.title, notes.title_key, notes.daily_date, notes.mtime,
                    aliases.alias, aliases.alias_key, {LINK_COUNT} AS link_count
             FROM aliases
             JOIN notes ON notes.path = aliases.note_path
             WHERE notes.kind != 'template' AND aliases.alias_key LIKE ?2 ESCAPE '\\'
             ORDER BY aliases.alias_key = ?1 DESC, link_count DESC, notes.mtime DESC
             LIMIT ?3"
        ))?
        .query_map(params![key, contains, WIKI_CANDIDATE_LIMIT], |row| {
            Ok(WikiAliasCandidate {
                path: row.get(0)?,
                title: row.get(1)?,
                title_key: row.get(2)?,
                daily_date: row.get(3)?,
                mtime: row.get(4)?,
                alias: row.get(5)?,
                alias_key: row.get(6)?,
                link_count: row.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?
    };
    Ok(WikiCandidates { titles, aliases })
}

/// The winner of each wiki key in `keys` that a note claims: `note_keys`
/// holds one winner per key.
pub(crate) fn key_winners(conn: &Connection, keys: &[String]) -> AppResult<Vec<WikiKeyWinner>> {
    let winners = conn
        .prepare_cached(
            "SELECT note_keys.key, note_keys.note_path, notes.daily_date, note_keys.claim_count
             FROM note_keys
             JOIN notes ON notes.path = note_keys.note_path
             WHERE note_keys.key IN (SELECT value FROM json_each(?1))",
        )?
        .query_map([json_list(keys)?], |row| {
            Ok(WikiKeyWinner {
                key: row.get(0)?,
                path: row.get(1)?,
                daily_date: row.get(2)?,
                claim_count: row.get(3)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(winners)
}

/// The aliases of the notes in `paths` that win their key with no other
/// claimant in the winning tier, in the order the notes declare them.
pub(crate) fn winning_aliases(
    conn: &Connection,
    paths: &[String],
) -> AppResult<Vec<WikiWinningAlias>> {
    let aliases = conn
        .prepare_cached(
            "SELECT aliases.note_path, aliases.alias FROM aliases
             JOIN note_keys ON note_keys.key = aliases.alias_key
               AND note_keys.note_path = aliases.note_path
             WHERE aliases.note_path IN (SELECT value FROM json_each(?1))
               AND note_keys.claim_count = 1
             ORDER BY aliases.rowid",
        )?
        .query_map([json_list(paths)?], |row| {
            Ok(WikiWinningAlias {
                note_path: row.get(0)?,
                alias: row.get(1)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(aliases)
}
