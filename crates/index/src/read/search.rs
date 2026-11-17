//! Search over the notes: a filtered recall feed without free text, a ranked
//! lexical search with it.

use rusqlite::{Connection, Row};
use sea_query::extension::sqlite::SqliteBinOper;
use sea_query::{
    BinOper, CommonTableExpression, Cond, Condition, Expr, ExprTrait, Func, Order, Query,
    SelectStatement, WithQuery,
};

use reflect_types::{AppResult, SearchHitRow, SearchRequest};

use super::lists::{FILTER_TAGS, from_tags_join_notes, order_pinned_first, order_recent};
use crate::schema::{Backlinks, Notes, SearchFts, Tags};
use crate::sql::{self, lit};
use crate::text::fts::{
    HIGHLIGHT_END, HIGHLIGHT_START, RANK_WEIGHTS, build_fts_match, title_recall_needles,
};

/// The columns of a hit, in the order `recall_hit` reads them.
const HIT_COLUMNS: [Notes; 6] = [
    Notes::Path,
    Notes::Title,
    Notes::DailyDate,
    Notes::Preview,
    Notes::Mtime,
    Notes::IsPinned,
];

/// The alias of the lexical hits.
const LEXICAL: &str = "lexical";
/// The alias of the filtered notes.
const FILTERED: &str = "fn";
const FTS_HIGHLIGHTED_TITLE: &str = "fts_highlighted_title";
const SNIPPET: &str = "snippet";
const RANK: &str = "rank";
const SCORE: &str = "score";

/// The filter predicates on `notes`. `tag_keys` are folded keys, matched
/// against the stored `tag_key`.
fn filters(request: &SearchRequest, tag_keys: &[String]) -> Condition {
    let note_path = || Expr::col((Notes::Table, Notes::Path));
    let mut filters = Cond::all();
    for tag_key in tag_keys {
        filters = filters.add(Expr::exists(
            Query::select()
                .expr(lit(1))
                .from_as(Tags::Table, FILTER_TAGS)
                .and_where(Expr::col((FILTER_TAGS, Tags::NotePath)).eq(note_path()))
                .and_where(Expr::col((FILTER_TAGS, Tags::TagKey)).eq(tag_key.as_str()))
                .take(),
        ));
    }
    if request.daily_only {
        filters = filters.add(Expr::col((Notes::Table, Notes::DailyDate)).is_not_null());
    }
    // An explicit daily filter and the notes-only population contradict; the
    // filter wins.
    if request.notes_only && !request.daily_only {
        filters = filters.add(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")));
    }
    if request.pinned_only {
        filters = filters.add(Expr::col((Notes::Table, Notes::IsPinned)).eq(lit(1)));
    }
    if let Some(target) = &request.links_to_path {
        filters = filters.add(Expr::exists(
            Query::select()
                .expr(lit(1))
                .from(Backlinks::Table)
                .and_where(Expr::col((Backlinks::Table, Backlinks::SourcePath)).eq(note_path()))
                .and_where(Expr::col((Backlinks::Table, Backlinks::TargetPath)).eq(target.as_str()))
                .take(),
        ));
    }
    if let Some(source) = &request.linked_from_path {
        filters = filters.add(Expr::exists(
            Query::select()
                .expr(lit(1))
                .from(Backlinks::Table)
                .and_where(Expr::col((Backlinks::Table, Backlinks::TargetPath)).eq(note_path()))
                .and_where(Expr::col((Backlinks::Table, Backlinks::SourcePath)).eq(source.as_str()))
                .take(),
        ));
    }
    filters
        .add_option(
            request
                .updated_after_ms
                .map(|after| Expr::col((Notes::Table, Notes::Mtime)).gte(after)),
        )
        .add_option(
            request
                .updated_before_ms
                .map(|before| Expr::col((Notes::Table, Notes::Mtime)).lt(before)),
        )
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
        return sql::query(conn, &recall_query(request), recall_hit);
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
    sql::query(conn, &ranked_query(request, fts_match, options), |row| {
        Ok(RankedHit {
            hit: SearchHitRow {
                fts_highlighted_title: row.get(6)?,
                snippet: row.get(7)?,
                ..recall_hit(row)?
            },
            score: row.get(8)?,
        })
    })
}

/// The lexical hits of `fts_match`: the path, the marked title and snippet,
/// and the title-boosted bm25 rank.
fn lexical_hits(fts_match: String, snippet_tokens: u8) -> SelectStatement {
    let fts = || Expr::col(SearchFts::Fts);
    let start = String::from(HIGHLIGHT_START);
    let end = String::from(HIGHLIGHT_END);
    let [path_weight, title_weight, body_weight] = RANK_WEIGHTS;
    Query::select()
        .expr_as(Expr::col((SearchFts::Table, SearchFts::Path)), Notes::Path)
        .expr_as(
            Func::cust("highlight")
                .arg(fts())
                .arg(lit(1))
                .arg(start.as_str())
                .arg(end.as_str()),
            FTS_HIGHLIGHTED_TITLE,
        )
        .expr_as(
            Func::cust("snippet")
                .arg(fts())
                .arg(lit(2))
                .arg(start)
                .arg(end)
                .arg(lit("…"))
                .arg(lit(i32::from(snippet_tokens))),
            SNIPPET,
        )
        .expr_as(
            Func::cust("bm25")
                .arg(fts())
                .arg(lit(path_weight))
                .arg(lit(title_weight))
                .arg(lit(body_weight)),
            RANK,
        )
        .from(SearchFts::Table)
        .and_where(fts().binary(SqliteBinOper::Match, fts_match))
        .take()
}

/// The ranked search for free text that compiles to `fts_match`.
pub(crate) fn ranked_query(
    request: &SearchRequest,
    fts_match: String,
    options: RankedOptions,
) -> WithQuery {
    // SQLite rejects `MATCH ... OR ...`, and a flattened FTS subquery under a
    // notes-first join reruns MATCH for every note. The materialized CTE
    // computes the lexical hits once; the outer join admits rows that only
    // title recall finds and keeps the FTS snippets.
    let lexical = CommonTableExpression::new()
        .query(lexical_hits(fts_match, options.snippet_tokens))
        .table_name(LEXICAL)
        .materialized(true)
        .to_owned();

    let title_key = || Expr::col((FILTERED, Notes::TitleKey));
    let instr = |text: Expr, needle: &str| Expr::from(Func::cust("instr").arg(text).arg(needle));
    // Every term matches the folded title: at a word start for scripts with
    // spaces, anywhere for scripts without.
    let needles = title_recall_needles(&request.title_key);
    let contains_all_terms = || -> Expr {
        if needles.is_empty() {
            return lit(0);
        }
        let mut all = Cond::all();
        for needle in &needles {
            let spaced_title = lit(" ").binary(BinOper::Custom("||"), title_key());
            all = all.add(instr(spaced_title, needle).gt(lit(0)));
        }
        all.into()
    };

    let mut filtered = Query::select();
    filtered
        .columns(HIT_COLUMNS.map(|column| (Notes::Table, column)))
        .column((Notes::Table, Notes::TitleKey))
        .from(Notes::Table)
        .and_where(Expr::col((Notes::Table, Notes::Kind)).ne(lit("template")));
    if options.exclude_private {
        filtered.and_where(Expr::col((Notes::Table, Notes::IsPrivate)).eq(lit(0)));
    }
    filtered.cond_where(filters(request, &request.tag_keys));

    // A title-only hit that title recall admits keeps score 0. A title that
    // only the tokenizer matches (`cafe` finds `Café`) keeps its bm25 rank, so
    // it still leads body hits.
    let snippet_has_match = instr(
        Func::coalesce([Expr::col((LEXICAL, SNIPPET)), lit("")]).into(),
        &String::from(HIGHLIGHT_START),
    )
    .gt(lit(0));
    let score = Expr::case(
        snippet_has_match.or(contains_all_terms().not()),
        Func::coalesce([Expr::col((LEXICAL, RANK)), lit(0)]),
    )
    .finally(lit(0));
    // The title rank: exact (0), whole-query prefix (1), all terms (2).
    let title_rank = Expr::case(title_key().eq(request.title_key.as_str()), lit(0))
        .case(instr(title_key(), &request.title_key).eq(lit(1)), lit(1))
        .case(contains_all_terms(), lit(2))
        .finally(lit(3));

    let mut query = Query::select();
    query
        .columns(HIT_COLUMNS.map(|column| (FILTERED, column)))
        .columns([(LEXICAL, FTS_HIGHLIGHTED_TITLE), (LEXICAL, SNIPPET)])
        .expr_as(score, SCORE)
        .from_subquery(filtered, FILTERED)
        .left_join(
            LEXICAL,
            Expr::col((LEXICAL, Notes::Path)).equals((FILTERED, Notes::Path)),
        )
        .cond_where(
            Cond::any()
                .add(Expr::col((LEXICAL, Notes::Path)).is_not_null())
                .add(contains_all_terms()),
        )
        .order_by_expr(title_rank.into(), Order::Asc)
        .order_by(SCORE, Order::Asc)
        .order_by((FILTERED, Notes::IsPinned), Order::Desc)
        .order_by((FILTERED, Notes::Mtime), Order::Desc)
        .order_by((FILTERED, Notes::Path), Order::Asc);
    if let Some(limit) = request.limit {
        query.limit(u64::from(limit));
    }
    query.with(Query::with().cte(lexical).to_owned())
}

/// The recall feed of a search without free text: the notes that pass the
/// filters of `request`, pins first when asked, then newest first.
pub(crate) fn recall_query(request: &SearchRequest) -> SelectStatement {
    let mut query = Query::select();
    query.columns(HIT_COLUMNS.map(|column| (Notes::Table, column)));
    let not_template = Expr::col((Notes::Table, Notes::Kind)).ne(lit("template"));
    match request.tag_keys.split_first() {
        // Start from the rows of the first tag instead of every note.
        Some((first, rest)) => {
            query.distinct();
            from_tags_join_notes(&mut query);
            query
                .and_where(Expr::col((Tags::Table, Tags::TagKey)).eq(first.as_str()))
                .and_where(not_template)
                .cond_where(filters(request, rest));
        }
        None => {
            query
                .from(Notes::Table)
                .and_where(not_template)
                .cond_where(filters(request, &[]));
        }
    }
    if request.pinned_first {
        order_pinned_first(&mut query);
    } else {
        order_recent(&mut query);
    }
    if let Some(limit) = request.limit {
        query.limit(u64::from(limit));
    }
    query
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
    let (sql, params) = sql::build(&ranked_query(request, fts_match, options));
    let plan = conn
        .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))?
        .query_map(rusqlite::params_from_iter(params), |row| row.get(3))?
        .collect::<Result<_, _>>()?;
    Ok(plan)
}
