//! The candidates of the tag and wiki link suggestions.

use rusqlite::Connection;
use sea_query::extension::sqlite::SqliteBinOper;
use sea_query::{Asterisk, Cond, Expr, ExprTrait, Func, LikeExpr, Order, Query, SelectStatement};

use reflect_types::{
    AppResult, TagFacet, WikiAliasCandidate, WikiCandidates, WikiKeyWinner, WikiTitleCandidate,
    WikiWinningAlias,
};

use super::lists::{tag_facet, tag_facets};
use crate::schema::{Aliases, Links, NoteClaims, NoteKeys, Notes, SearchFts, Tags};
use crate::sql::{self, lit};
use crate::text::fts::build_fts_title_prefix_match;

/// The size of each candidate pool. Ranking happens in the frontend.
const WIKI_CANDIDATE_LIMIT: u64 = 200;

const LINK_COUNT: &str = "link_count";

/// The number of links that point at a key the note claims.
fn link_count() -> SelectStatement {
    Query::select()
        .expr(Func::count(Expr::col(Asterisk)))
        .from(NoteClaims::Table)
        .inner_join(
            Links::Table,
            Expr::col((Links::Table, Links::TargetKey))
                .equals((NoteClaims::Table, NoteClaims::Key)),
        )
        .and_where(
            Expr::col((NoteClaims::Table, NoteClaims::NotePath))
                .equals((Notes::Table, Notes::Path)),
        )
        .take()
}

/// A `LIKE` pattern that matches `key` anywhere, with `\` as the escape.
fn like_contains(key: &str) -> LikeExpr {
    let mut pattern = String::with_capacity(key.len() + 2);
    pattern.push('%');
    for character in key.chars() {
        if matches!(character, '\\' | '%' | '_') {
            pattern.push('\\');
        }
        pattern.push(character);
    }
    pattern.push('%');
    LikeExpr::new(pattern).escape('\\')
}

/// The most used tags whose key contains `tag_key` (every tag when it is
/// empty), most used first, at most `limit`. Templates do not count.
pub(crate) fn tags_query(tag_key: &str, limit: u32) -> SelectStatement {
    let mut query = tag_facets();
    query.and_where(Expr::col((Notes::Table, Notes::Kind)).ne(lit("template")));
    if !tag_key.is_empty() {
        query.and_where(Expr::col((Tags::Table, Tags::TagKey)).like(like_contains(tag_key)));
    }
    query
        .order_by_expr(Func::count(Expr::col(Asterisk)).into(), Order::Desc)
        .order_by_expr(
            Func::min(Expr::col((Tags::Table, Tags::Tag))).into(),
            Order::Asc,
        )
        .limit(u64::from(limit));
    query
}

/// The rows of [`tags_query`].
pub(crate) fn tags(conn: &Connection, tag_key: &str, limit: u32) -> AppResult<Vec<TagFacet>> {
    sql::query(conn, &tags_query(tag_key, limit), tag_facet)
}

/// The notes whose title matches the folded wiki key `key`, with the number
/// of links to each, at most [`WIKI_CANDIDATE_LIMIT`]: an exact title first,
/// then a title that contains the key, then by link count and recency. The
/// search index also admits titles that differ only in accents. An empty key
/// lists the notes that are not daily notes.
pub(crate) fn title_candidates_query(key: &str) -> SelectStatement {
    let title_contains = || Expr::col((Notes::Table, Notes::TitleKey)).like(like_contains(key));

    let mut query = Query::select();
    query
        .columns([
            (Notes::Table, Notes::Path),
            (Notes::Table, Notes::Title),
            (Notes::Table, Notes::TitleKey),
            (Notes::Table, Notes::DailyDate),
            (Notes::Table, Notes::Mtime),
        ])
        .expr_as(link_count(), LINK_COUNT)
        .from(Notes::Table)
        .and_where(Expr::col((Notes::Table, Notes::Kind)).ne(lit("template")));
    if key.is_empty() {
        query.and_where(Expr::col((Notes::Table, Notes::DailyDate)).is_null());
    } else if let Some(fts_match) = build_fts_title_prefix_match(key) {
        let fts_paths = Query::select()
            .column(SearchFts::Path)
            .from(SearchFts::Table)
            .and_where(Expr::col(SearchFts::Fts).binary(SqliteBinOper::Match, fts_match))
            .take();
        query.cond_where(
            Cond::any()
                .add(title_contains())
                .add(Expr::col((Notes::Table, Notes::Path)).in_subquery(fts_paths)),
        );
    } else {
        query.and_where(title_contains());
    }
    query
        .order_by_expr(
            Expr::col((Notes::Table, Notes::TitleKey)).eq(key),
            Order::Desc,
        )
        .order_by_expr(title_contains(), Order::Desc)
        .order_by(LINK_COUNT, Order::Desc)
        .order_by((Notes::Table, Notes::Mtime), Order::Desc)
        .limit(WIKI_CANDIDATE_LIMIT);
    query
}

/// The notes whose title or alias matches the folded wiki key `key`.
///
/// The pool is cut by usage before recency: a much-linked note stays in it
/// however long ago its file changed, and an exact hit is always kept. The
/// search index also admits titles that differ only in accents; those rank
/// below spelled hits. An empty key lists notes only: days come from the date
/// generator of the frontend.
pub(crate) fn wiki_candidates(conn: &Connection, key: &str) -> AppResult<WikiCandidates> {
    let titles = sql::query(conn, &title_candidates_query(key), |row| {
        Ok(WikiTitleCandidate {
            path: row.get(0)?,
            title: row.get(1)?,
            title_key: row.get(2)?,
            daily_date: row.get(3)?,
            mtime: row.get(4)?,
            link_count: row.get(5)?,
        })
    })?;

    let aliases = if key.is_empty() {
        Vec::new()
    } else {
        sql::query(
            conn,
            Query::select()
                .columns([
                    (Notes::Table, Notes::Path),
                    (Notes::Table, Notes::Title),
                    (Notes::Table, Notes::TitleKey),
                    (Notes::Table, Notes::DailyDate),
                    (Notes::Table, Notes::Mtime),
                ])
                .columns([
                    (Aliases::Table, Aliases::Alias),
                    (Aliases::Table, Aliases::AliasKey),
                ])
                .expr_as(link_count(), LINK_COUNT)
                .from(Aliases::Table)
                .inner_join(
                    Notes::Table,
                    Expr::col((Notes::Table, Notes::Path))
                        .equals((Aliases::Table, Aliases::NotePath)),
                )
                .and_where(Expr::col((Notes::Table, Notes::Kind)).ne(lit("template")))
                .and_where(Expr::col((Aliases::Table, Aliases::AliasKey)).like(like_contains(key)))
                .order_by_expr(
                    Expr::col((Aliases::Table, Aliases::AliasKey)).eq(key),
                    Order::Desc,
                )
                .order_by(LINK_COUNT, Order::Desc)
                .order_by((Notes::Table, Notes::Mtime), Order::Desc)
                .limit(WIKI_CANDIDATE_LIMIT),
            |row| {
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
            },
        )?
    };
    Ok(WikiCandidates { titles, aliases })
}

/// The winner of each wiki key in `keys` that a note claims: `note_keys`
/// holds one winner per key.
pub(crate) fn key_winners(conn: &Connection, keys: &[String]) -> AppResult<Vec<WikiKeyWinner>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                (NoteKeys::Table, NoteKeys::Key),
                (NoteKeys::Table, NoteKeys::NotePath),
            ])
            .column((Notes::Table, Notes::DailyDate))
            .column((NoteKeys::Table, NoteKeys::ClaimCount))
            .from(NoteKeys::Table)
            .inner_join(
                Notes::Table,
                Expr::col((Notes::Table, Notes::Path))
                    .equals((NoteKeys::Table, NoteKeys::NotePath)),
            )
            .and_where(
                Expr::col((NoteKeys::Table, NoteKeys::Key)).in_subquery(sql::json_values(keys)?),
            ),
        |row| {
            Ok(WikiKeyWinner {
                key: row.get(0)?,
                path: row.get(1)?,
                daily_date: row.get(2)?,
                claim_count: row.get(3)?,
            })
        },
    )
}

/// The aliases of the notes in `paths` that win their key with no other
/// claimant in the winning tier, in the order the notes declare them.
pub(crate) fn winning_aliases(
    conn: &Connection,
    paths: &[String],
) -> AppResult<Vec<WikiWinningAlias>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                (Aliases::Table, Aliases::NotePath),
                (Aliases::Table, Aliases::Alias),
            ])
            .from(Aliases::Table)
            .inner_join(
                NoteKeys::Table,
                Expr::col((NoteKeys::Table, NoteKeys::Key))
                    .equals((Aliases::Table, Aliases::AliasKey))
                    .and(
                        Expr::col((NoteKeys::Table, NoteKeys::NotePath))
                            .equals((Aliases::Table, Aliases::NotePath)),
                    ),
            )
            .and_where(
                Expr::col((Aliases::Table, Aliases::NotePath))
                    .in_subquery(sql::json_values(paths)?),
            )
            .and_where(Expr::col((NoteKeys::Table, NoteKeys::ClaimCount)).eq(lit(1)))
            .order_by((Aliases::Table, sql::ROWID), Order::Asc),
        |row| {
            Ok(WikiWinningAlias {
                note_path: row.get(0)?,
                alias: row.get(1)?,
            })
        },
    )
}
