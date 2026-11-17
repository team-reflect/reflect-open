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

use reflect_index::text::fts::{HIGHLIGHT_END, HIGHLIGHT_START, RANK_EXPR, title_recall_needles};
use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};

use crate::error::CliError;

/// One search result row.
#[derive(Debug)]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    /// FTS5 `snippet()` over the indexed plain-text body.
    pub snippet: String,
    /// Title-boosted bm25 score (more negative = better); `0` for title-recall hits.
    pub score: f64,
}

/// Ranked, private-excluded search mirroring the desktop palette ordering
/// (`filtered-search.ts`): exact, prefix, and all-terms title matches first,
/// then title-boosted bm25, pinned and recency tiebreakers, then `path`. A
/// materialized CTE runs MATCH once because SQLite rejects it beneath a plain
/// OR and otherwise flattens a derived FTS join into one scan per note. The
/// LEFT JOIN admits title-recall-only rows. Matches already covered by title
/// recall keep an empty snippet and score `0`, while tokenizer-normalized title
/// matches retain their lexical rank. The caller re-checks each hit's file
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
           SELECT path, snippet(search_fts, 2, char(1), char(2), '…', 12) AS snippet,
                  {RANK_EXPR} AS rank
           FROM search_fts
           WHERE search_fts MATCH ?1
         )
         SELECT notes.path, notes.title, coalesce(lexical.snippet, ''),
                CASE
                  WHEN instr(coalesce(lexical.snippet, ''), char(1)) > 0
                    OR NOT ({title_term_predicate})
                    THEN coalesce(lexical.rank, 0)
                  ELSE 0
                END AS effective_rank
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
                  effective_rank,
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
        let marked_snippet: String = row.get(2)?;
        let has_body_match = marked_snippet.contains(HIGHLIGHT_START);
        let snippet = if has_body_match {
            marked_snippet.replace([HIGHLIGHT_START, HIGHLIGHT_END], "")
        } else {
            String::new()
        };
        Ok(SearchHit {
            path: row.get(0)?,
            title: row.get(1)?,
            snippet,
            score: row.get(3)?,
        })
    })?;
    let mut hits = Vec::new();
    for row in rows {
        hits.push(row?);
    }
    Ok(hits)
}
