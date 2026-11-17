//! Search over the notes: a filtered recall feed without free text, a ranked
//! lexical search with it.

use rusqlite::types::Value;
use rusqlite::{Connection, Row, params_from_iter};

use reflect_types::{AppResult, SearchHitRow, SearchRequest};

use super::lists::{PINNED_FIRST_ORDER, RECENT_ORDER};
use crate::text::fts::{
    HIGHLIGHT_END, HIGHLIGHT_START, RANK_EXPR, build_fts_match, title_recall_needles,
};

const HIT_COLUMNS: &str =
    "notes.path, notes.title, notes.daily_date, notes.preview, notes.mtime, notes.is_pinned";

/// SQL text with its bound parameters, built from constant fragments.
#[derive(Default)]
struct Sql {
    text: String,
    params: Vec<Value>,
}

impl Sql {
    fn push(&mut self, fragment: &str) {
        self.text.push_str(fragment);
    }

    fn bind(&mut self, fragment: &str, value: impl Into<Value>) {
        self.text.push_str(fragment);
        self.params.push(value.into());
    }

    fn limit(&mut self, limit: Option<u32>) {
        if let Some(limit) = limit {
            self.bind(" LIMIT ?", i64::from(limit));
        }
    }
}

/// The filter predicates on `notes`, each as ` AND ...`. `tag_keys` are
/// folded keys, matched against the stored `tag_key`.
fn push_filters(sql: &mut Sql, request: &SearchRequest, tag_keys: &[String]) {
    for tag_key in tag_keys {
        sql.bind(
            " AND EXISTS (SELECT 1 FROM tags AS filter_tags
               WHERE filter_tags.note_path = notes.path AND filter_tags.tag_key = ?)",
            tag_key.clone(),
        );
    }
    if request.daily_only {
        sql.push(" AND notes.daily_date IS NOT NULL");
    }
    // An explicit daily filter and the notes-only population contradict; the
    // filter wins.
    if request.notes_only && !request.daily_only {
        sql.push(" AND notes.kind = 'note'");
    }
    if request.pinned_only {
        sql.push(" AND notes.is_pinned = 1");
    }
    if let Some(target) = &request.links_to_path {
        sql.bind(
            " AND EXISTS (SELECT 1 FROM backlinks
               WHERE backlinks.source_path = notes.path AND backlinks.target_path = ?)",
            target.clone(),
        );
    }
    if let Some(source) = &request.linked_from_path {
        sql.bind(
            " AND EXISTS (SELECT 1 FROM backlinks
               WHERE backlinks.target_path = notes.path AND backlinks.source_path = ?)",
            source.clone(),
        );
    }
    if let Some(after) = request.updated_after_ms {
        sql.bind(" AND notes.mtime >= ?", after);
    }
    if let Some(before) = request.updated_before_ms {
        sql.bind(" AND notes.mtime < ?", before);
    }
}

fn recall_hit(row: &Row<'_>) -> rusqlite::Result<SearchHitRow> {
    Ok(SearchHitRow {
        path: row.get(0)?,
        title: row.get(1)?,
        daily_date: row.get(2)?,
        preview: row.get(3)?,
        mtime: row.get(4)?,
        is_pinned: row.get(5)?,
        fts_highlighted_title: None,
        snippet: None,
    })
}

/// How the ranked search differs between its callers.
#[derive(Clone, Copy, Debug)]
pub struct RankedOptions {
    /// Leaves private notes out.
    pub exclude_private: bool,
    /// The most tokens of a body snippet.
    pub snippet_tokens: u8,
}

/// One hit of the ranked search.
#[derive(Debug)]
pub struct RankedHit {
    pub hit: SearchHitRow,
    /// The title-boosted bm25 rank; a lower value is better. It is 0 for a
    /// hit that title recall alone admits.
    pub score: f64,
}

/// The notes that match `request`. Templates never match.
///
/// Without free text the result is a recall feed: pins first when asked, then
/// newest first. With free text it is ranked, see [`search_ranked`].
pub(crate) fn search(conn: &Connection, request: &SearchRequest) -> AppResult<Vec<SearchHitRow>> {
    if build_fts_match(&request.text).is_none() {
        return recall(conn, request);
    }
    let options = RankedOptions {
        exclude_private: false,
        snippet_tokens: 10,
    };
    Ok(search_ranked(conn, request, options)?
        .into_iter()
        .map(|ranked| ranked.hit)
        .collect())
}

/// The notes that match the free text and the filters of `request`, ranked:
/// exact, prefix and all-terms title matches lead, then the title-boosted
/// bm25 rank, pins, recency and the path. Text with no search term matches
/// nothing.
pub fn search_ranked(
    conn: &Connection,
    request: &SearchRequest,
    options: RankedOptions,
) -> AppResult<Vec<RankedHit>> {
    let Some(fts_match) = build_fts_match(&request.text) else {
        return Ok(Vec::new());
    };
    let sql = ranked_sql(request, fts_match, options);
    let hits = conn
        .prepare_cached(&sql.text)?
        .query_map(params_from_iter(sql.params), |row| {
            Ok(RankedHit {
                hit: SearchHitRow {
                    fts_highlighted_title: row.get(6)?,
                    snippet: row.get(7)?,
                    ..recall_hit(row)?
                },
                score: row.get(8)?,
            })
        })?
        .collect::<Result<_, _>>()?;
    Ok(hits)
}

/// The ranked search for free text that compiles to `fts_match`.
fn ranked_sql(request: &SearchRequest, fts_match: String, options: RankedOptions) -> Sql {
    // SQLite rejects `MATCH ... OR ...`, and a flattened FTS subquery under a
    // notes-first join reruns MATCH for every note. The materialized CTE
    // computes the lexical hits once; the outer join admits rows that only
    // title recall finds and keeps the FTS snippets.
    let mut sql = Sql::default();
    sql.bind(
        "WITH lexical AS MATERIALIZED (
           SELECT search_fts.path AS path,
                  highlight(search_fts, 1, ?",
        String::from(HIGHLIGHT_START),
    );
    sql.bind(
        ", ?) AS fts_highlighted_title,",
        String::from(HIGHLIGHT_END),
    );
    sql.bind(" snippet(search_fts, 2, ?", String::from(HIGHLIGHT_START));
    sql.bind(
        &format!(", ?, '…', {}) AS snippet,", options.snippet_tokens),
        String::from(HIGHLIGHT_END),
    );
    sql.push(&format!(" {RANK_EXPR} AS rank FROM search_fts"));
    sql.bind(" WHERE search_fts MATCH ?)", fts_match);

    // Every term matches the folded title: at a word start for scripts with
    // spaces, anywhere for scripts without.
    let needles = title_recall_needles(&request.title_key);
    let push_contains_all_terms = |sql: &mut Sql| {
        if needles.is_empty() {
            sql.push("0");
            return;
        }
        sql.push("(");
        for (at, needle) in needles.iter().enumerate() {
            if at > 0 {
                sql.push(" AND ");
            }
            sql.bind("instr(' ' || fn.title_key, ?) > 0", needle.clone());
        }
        sql.push(")");
    };
    // A title-only hit that title recall admits keeps score 0. A title that
    // only the tokenizer matches (`cafe` finds `Café`) keeps its bm25 rank, so
    // it still leads body hits.
    sql.bind(
        " SELECT fn.path, fn.title, fn.daily_date, fn.preview, fn.mtime, fn.is_pinned,
                 lexical.fts_highlighted_title, lexical.snippet,
                 CASE WHEN instr(coalesce(lexical.snippet, ''), ?) > 0 OR NOT (",
        String::from(HIGHLIGHT_START),
    );
    push_contains_all_terms(&mut sql);
    sql.push(&format!(
        ") THEN coalesce(lexical.rank, 0) ELSE 0 END AS score
          FROM (SELECT {HIT_COLUMNS}, notes.title_key FROM notes
                WHERE notes.kind != 'template'"
    ));
    if options.exclude_private {
        sql.push(" AND notes.is_private = 0");
    }
    push_filters(&mut sql, request, &request.tag_keys);
    sql.push(
        ") AS fn LEFT JOIN lexical ON lexical.path = fn.path
          WHERE (lexical.path IS NOT NULL OR ",
    );
    push_contains_all_terms(&mut sql);
    // The title rank: exact (0), whole-query prefix (1), all terms (2).
    sql.bind(
        ") ORDER BY CASE WHEN fn.title_key = ? THEN 0",
        request.title_key.clone(),
    );
    sql.bind(
        " WHEN instr(fn.title_key, ?) = 1 THEN 1 WHEN ",
        request.title_key.clone(),
    );
    push_contains_all_terms(&mut sql);
    sql.push(" THEN 2 ELSE 3 END, score, fn.is_pinned DESC, fn.mtime DESC, fn.path ASC");
    sql.limit(request.limit);
    sql
}

/// The recall feed of a search without free text.
fn recall(conn: &Connection, request: &SearchRequest) -> AppResult<Vec<SearchHitRow>> {
    let mut sql = Sql::default();
    match request.tag_keys.split_first() {
        // Start from the rows of the first tag instead of every note.
        Some((first, rest)) => {
            sql.push(&format!(
                "SELECT DISTINCT {HIT_COLUMNS} FROM tags
                 JOIN notes ON notes.path = tags.note_path"
            ));
            sql.bind(
                " WHERE tags.tag_key = ? AND notes.kind != 'template'",
                first.clone(),
            );
            push_filters(&mut sql, request, rest);
        }
        None => {
            sql.push(&format!(
                "SELECT {HIT_COLUMNS} FROM notes WHERE notes.kind != 'template'"
            ));
            push_filters(&mut sql, request, &[]);
        }
    }
    sql.push(" ORDER BY ");
    sql.push(if request.pinned_first {
        PINNED_FIRST_ORDER
    } else {
        RECENT_ORDER
    });
    sql.limit(request.limit);
    let hits = conn
        .prepare_cached(&sql.text)?
        .query_map(params_from_iter(sql.params), recall_hit)?
        .collect::<Result<_, _>>()?;
    Ok(hits)
}

#[cfg(test)]
pub(crate) fn ranked_query_plan(
    conn: &Connection,
    request: &SearchRequest,
) -> AppResult<Vec<String>> {
    let fts_match = build_fts_match(&request.text).unwrap_or_default();
    let options = RankedOptions {
        exclude_private: false,
        snippet_tokens: 10,
    };
    let sql = ranked_sql(request, fts_match, options);
    let plan = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {}", sql.text))?
        .query_map(params_from_iter(sql.params), |row| row.get(3))?
        .collect::<Result<_, _>>()?;
    Ok(plan)
}
