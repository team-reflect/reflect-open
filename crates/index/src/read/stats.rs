//! Graph-level aggregates over the non-private notes.

use rusqlite::Connection;
use sea_query::{Asterisk, Expr, ExprTrait, Func, Order, Query};

use reflect_types::{AppResult, GraphStats, TagFacet};

use crate::schema::{Notes, Tags};
use crate::sql::{self, lit};

/// The aggregates of the graph. `tag_limit` caps the tag facets: the most-used
/// tags win.
pub(crate) fn graph_stats(conn: &Connection, tag_limit: u32) -> AppResult<GraphStats> {
    let note_count = sql::query_one(
        conn,
        Query::select()
            .expr(Func::count(Expr::col(Asterisk)))
            .from(Notes::Table)
            .and_where(Expr::col(Notes::Kind).eq(lit("note")))
            .and_where(Expr::col(Notes::IsPrivate).eq(lit(0))),
        |row| row.get(0),
    )?;
    let (daily_note_count, earliest_daily_date, latest_daily_date) = sql::query_one(
        conn,
        Query::select()
            .expr(Func::count(Expr::col(Asterisk)))
            .expr(Func::min(Expr::col(Notes::DailyDate)))
            .expr(Func::max(Expr::col(Notes::DailyDate)))
            .from(Notes::Table)
            .and_where(Expr::col(Notes::DailyDate).is_not_null())
            .and_where(Expr::col(Notes::IsPrivate).eq(lit(0))),
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )?;
    // One row past the limit shows that more tags exist.
    let mut tags: Vec<TagFacet> = sql::query(
        conn,
        Query::select()
            .expr(Func::min(Expr::col((Tags::Table, Tags::Tag))))
            .expr(Func::count(Expr::col(Asterisk)))
            .from(Tags::Table)
            .inner_join(
                Notes::Table,
                Expr::col((Notes::Table, Notes::Path)).equals((Tags::Table, Tags::NotePath)),
            )
            .and_where(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")))
            .and_where(Expr::col((Notes::Table, Notes::IsPrivate)).eq(lit(0)))
            .group_by_col((Tags::Table, Tags::TagKey))
            .order_by_expr(Func::count(Expr::col(Asterisk)).into(), Order::Desc)
            .order_by((Tags::Table, Tags::TagKey), Order::Asc)
            .limit(u64::from(tag_limit) + 1),
        |row| {
            Ok(TagFacet {
                tag: row.get(0)?,
                count: row.get(1)?,
            })
        },
    )?;
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
