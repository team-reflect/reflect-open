//! Lexical search over the FTS index. The `MATCH` expression is built exactly
//! like `buildFtsMatch` (`packages/core/src/indexing/search-query.ts`) and the
//! query mirrors the desktop's `searchNotes` (bm25 `ORDER BY rank`), with the
//! CLI's privacy filter (`notes.is_private = 0`) and FTS5 `snippet()` added.

use rusqlite::{params, Connection};

use crate::error::CliError;

/// Build an FTS5 `MATCH` expression from a free-text query, or `None` when
/// there is nothing to search. Every whitespace-split term is double-quoted
/// (embedded quotes doubled) so user input is matched literally — operators
/// like `AND`/`*` can't change the query's meaning or raise syntax errors.
pub fn build_fts_match(query: &str) -> Option<String> {
    let terms: Vec<String> = query
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect();
    if terms.is_empty() {
        return None;
    }
    Some(terms.join(" "))
}

/// One search result row.
#[derive(Debug)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// FTS5 `snippet()` over the indexed plain-text body.
    pub snippet: String,
    /// bm25 rank (more negative = better match).
    pub score: f64,
}

/// Ranked, private-excluded search. The caller re-checks each hit's file
/// frontmatter (the index row may lag a just-flagged note).
pub fn search_index(
    conn: &Connection,
    match_expr: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, CliError> {
    let mut statement = conn.prepare(
        "SELECT search_fts.path, search_fts.title,
                snippet(search_fts, 2, '', '', '…', 12), rank
         FROM search_fts
         JOIN notes ON notes.path = search_fts.path
         WHERE search_fts MATCH ?1 AND notes.is_private = 0
         ORDER BY rank
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![match_expr, limit as i64], |row| {
        Ok(SearchHit {
            path: row.get(0)?,
            title: row.get(1)?,
            snippet: row.get(2)?,
            score: row.get(3)?,
        })
    })?;
    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }
    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::build_fts_match;

    /// Parity with `buildFtsMatch` (`search-query.test.ts`) — same inputs,
    /// same expressions, byte for byte.
    #[test]
    fn match_expressions_match_the_ts_builder() {
        assert_eq!(build_fts_match(""), None);
        assert_eq!(build_fts_match("   \t \n "), None);
        assert_eq!(build_fts_match("hello"), Some("\"hello\"".to_string()));
        assert_eq!(
            build_fts_match("cats AND (dogs*)"),
            Some("\"cats\" \"AND\" \"(dogs*)\"".to_string())
        );
        assert_eq!(
            build_fts_match("say \"hi\""),
            Some("\"say\" \"\"\"hi\"\"\"".to_string())
        );
        assert_eq!(
            build_fts_match("  alpha   beta "),
            Some("\"alpha\" \"beta\"".to_string())
        );
    }
}
