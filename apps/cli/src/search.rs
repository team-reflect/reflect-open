//! Lexical search over the FTS index. The `MATCH` expression is built exactly
//! like `buildFtsMatch` (`packages/core/src/indexing/search-query.ts`) and
//! ranking matches the desktop's palette search (`filtered-search.ts`): exact,
//! prefix, and all-terms title matches lead, then title-boosted bm25 with the
//! same column weights, pinned, recency, and `path`. Folded title recall
//! matches each term at a title word start — except terms in unsegmented
//! scripts, which match anywhere: FTS5's `unicode61` tokenizer cannot match
//! part of an uninterrupted CJK title (`titleRecallNeedles` in
//! `search-query.ts` is the TS twin). The CLI adds its privacy filter
//! (`notes.is_private = 0`) and FTS5 `snippet()`.

use rusqlite::types::Value;
use rusqlite::{params_from_iter, Connection};

use crate::error::CliError;
use crate::keys::contains_unsegmented_script;

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
    /// Title-boosted bm25 score (more negative = better); `0` for title-only hits.
    pub score: f64,
}

/// The `instr` needles for title recall, one per folded query term — the twin
/// of `titleRecallNeedles` (`search-query.ts`). Matched against
/// `' ' || notes.title_key`: terms in space-delimited scripts carry a leading
/// space so they only match at word starts (`car` finds `Car log`, not
/// `Oscar party`), while unsegmented-script terms match anywhere.
fn title_recall_needles(title_key: &str) -> Vec<String> {
    title_key
        .split_whitespace()
        .map(|term| {
            if contains_unsegmented_script(term) {
                term.to_owned()
            } else {
                format!(" {term}")
            }
        })
        .collect()
}

/// The palette search's bm25 column weights (`filtered-search.ts`): path
/// unranked, title boosted 10× over body. Must stay in lockstep.
const RANK_EXPR: &str = "bm25(search_fts, 0, 10.0, 1.0)";

/// Ranked, private-excluded search mirroring the desktop palette ordering
/// (`filtered-search.ts`): exact, prefix, and all-terms title matches first,
/// then title-boosted bm25, pinned and recency tiebreakers, then `path`. A
/// materialized CTE runs MATCH once because SQLite rejects it beneath a plain
/// OR and otherwise flattens a derived FTS join into one scan per note. The
/// LEFT JOIN admits title-recall-only rows. Their snippet is empty and score
/// is `0`, since no FTS rank exists. The caller re-checks each hit's file
/// frontmatter (the index row may lag a just-flagged note).
pub fn search_index(
    conn: &Connection,
    match_expr: &str,
    title_key: &str,
    limit: usize,
) -> Result<Vec<SearchHit>, CliError> {
    let needles = title_recall_needles(title_key);
    if needles.is_empty() {
        return Ok(Vec::new());
    }
    let title_term_predicate = needles
        .iter()
        .enumerate()
        .map(|(index, _)| format!("instr(' ' || notes.title_key, ?{}) > 0", index + 3))
        .collect::<Vec<String>>()
        .join(" AND ");
    let limit_parameter = needles.len() + 3;
    let mut statement = conn.prepare(&format!(
        "WITH lexical AS MATERIALIZED (
           SELECT path, snippet(search_fts, 2, '', '', '…', 12) AS snippet,
                  {RANK_EXPR} AS rank
           FROM search_fts
           WHERE search_fts MATCH ?1
         )
         SELECT notes.path, notes.title,
                coalesce(lexical.snippet, ''), coalesce(lexical.rank, 0)
         FROM notes
         LEFT JOIN lexical ON lexical.path = notes.path
         WHERE (lexical.path IS NOT NULL OR ({title_term_predicate}))
           AND notes.is_private = 0 AND notes.kind != 'template'
         ORDER BY CASE
                    WHEN notes.title_key = ?2 THEN 0
                    WHEN instr(notes.title_key, ?2) = 1 THEN 1
                    WHEN {title_term_predicate} THEN 2
                    ELSE 3
                  END,
                  coalesce(lexical.rank, 0),
                  notes.is_pinned DESC,
                  notes.mtime DESC,
                  notes.path ASC
         LIMIT ?{limit_parameter}",
    ))?;
    let mut parameters = vec![
        Value::Text(match_expr.to_owned()),
        Value::Text(title_key.to_owned()),
    ];
    parameters.extend(needles.into_iter().map(Value::Text));
    parameters.push(Value::Integer(limit as i64));
    let rows = statement.query_map(params_from_iter(parameters), |row| {
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
    use super::{build_fts_match, title_recall_needles};

    /// Parity with `titleRecallNeedles` (`search-query.ts`): space-delimited
    /// terms anchor at word starts (leading space); unsegmented-script terms
    /// match anywhere (no anchor).
    #[test]
    fn needles_match_the_ts_builder() {
        assert_eq!(title_recall_needles("tokyo 東京"), vec![" tokyo", "東京"]);
        assert_eq!(title_recall_needles("car"), vec![" car"]);
        assert_eq!(title_recall_needles(""), Vec::<String>::new());
    }

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
