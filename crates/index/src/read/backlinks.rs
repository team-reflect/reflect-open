//! Reads of the `backlinks` view: the links that point at a note.

use std::collections::HashMap;

use rusqlite::Connection;
use sea_query::{Asterisk, Cond, Condition, Expr, ExprTrait, Func, Order, Query, SelectStatement};

use reflect_types::{
    AppError, AppResult, Backlink, BacklinkPage, BacklinkSource, BacklinkSourceCursor,
};

use crate::schema::{Backlinks, NoteKeys, Notes};
use crate::sql::{self, lit};

/// The alias of the recency of a source note.
const RECENCY: &str = "recency";
const SOURCE_PATH: &str = "source_path";
const SOURCE_TITLE: &str = "source_title";
const POS_FROM: &str = "pos_from";
/// The alias of the subquery that holds the links with their recency.
const SOURCES: &str = "sources";

/// The recency of a source note: its daily date, else its last change, in
/// epoch ms.
fn recency() -> Expr {
    let daily_seconds = Func::cust("strftime")
        .arg(lit("%s"))
        .arg(Expr::col((Notes::Table, Notes::DailyDate)));
    Func::coalesce([
        Expr::from(daily_seconds).mul(lit(1000)),
        Expr::col((Notes::Table, Notes::UpdatedAt)),
    ])
    .into()
}

/// `backlinks JOIN notes` on the source, for the links to the note at `path`.
fn links_to(path: &str) -> SelectStatement {
    Query::select()
        .from(Backlinks::Table)
        .inner_join(
            Notes::Table,
            Expr::col((Notes::Table, Notes::Path))
                .equals((Backlinks::Table, Backlinks::SourcePath)),
        )
        .and_where(Expr::col((Backlinks::Table, Backlinks::TargetPath)).eq(path))
        .take()
}

/// The sources strictly after `cursor` in (recency DESC, path) order.
fn after(cursor: &BacklinkSourceCursor) -> Condition {
    Cond::any()
        .add(Expr::col(RECENCY).lt(cursor.recency_ms))
        .add(
            Cond::all()
                .add(Expr::col(RECENCY).eq(cursor.recency_ms))
                .add(Expr::col(SOURCE_PATH).gt(cursor.source_path.as_str())),
        )
}

/// Every link that points at the note at `path`, by source path.
pub(crate) fn backlinks(conn: &Connection, path: &str) -> AppResult<Vec<Backlink>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                Backlinks::SourcePath,
                Backlinks::TargetRaw,
                Backlinks::Alias,
                Backlinks::PosFrom,
                Backlinks::PosTo,
            ])
            .from(Backlinks::Table)
            .and_where(Expr::col(Backlinks::TargetPath).eq(path))
            .order_by(Backlinks::SourcePath, Order::Asc),
        |row| {
            Ok(Backlink {
                source_path: row.get(0)?,
                target_raw: row.get(1)?,
                alias: row.get(2)?,
                pos_from: row.get(3)?,
                pos_to: row.get(4)?,
            })
        },
    )
}

/// The path, the title and the recency of each source that links to the note
/// at `path`, after `cursor`: most recent first, then by path. It has one row
/// more than `limit`, which shows that another page exists.
pub(crate) fn page_sources_query(
    path: &str,
    limit: i64,
    cursor: Option<&BacklinkSourceCursor>,
) -> SelectStatement {
    Query::select()
        .distinct()
        .columns([SOURCE_PATH, SOURCE_TITLE, RECENCY])
        .from_subquery(
            links_to(path)
                .expr_as(
                    Expr::col((Backlinks::Table, Backlinks::SourcePath)),
                    SOURCE_PATH,
                )
                .expr_as(Expr::col((Notes::Table, Notes::Title)), SOURCE_TITLE)
                .expr_as(recency(), RECENCY)
                .take(),
            SOURCES,
        )
        .cond_where(Cond::all().add_option(cursor.map(after)))
        .order_by(RECENCY, Order::Desc)
        .order_by(SOURCE_PATH, Order::Asc)
        .limit(limit.saturating_add(1).unsigned_abs())
        .take()
}

/// The position of each link to the note at `path` from the sources after
/// `cursor` up to the source `last`, in page order.
pub(crate) fn page_positions_query(
    path: &str,
    cursor: Option<&BacklinkSourceCursor>,
    last: &BacklinkSourceCursor,
) -> SelectStatement {
    let through_last = Cond::any().add(Expr::col(RECENCY).gt(last.recency_ms)).add(
        Cond::all()
            .add(Expr::col(RECENCY).eq(last.recency_ms))
            .add(Expr::col(SOURCE_PATH).lte(last.source_path.as_str())),
    );
    Query::select()
        .columns([SOURCE_PATH, POS_FROM])
        .from_subquery(
            links_to(path)
                .expr_as(
                    Expr::col((Backlinks::Table, Backlinks::SourcePath)),
                    SOURCE_PATH,
                )
                .expr_as(Expr::col((Backlinks::Table, Backlinks::PosFrom)), POS_FROM)
                .expr_as(recency(), RECENCY)
                .take(),
            SOURCES,
        )
        .cond_where(Cond::all().add_option(cursor.map(after)).add(through_last))
        .order_by(RECENCY, Order::Desc)
        .order_by(SOURCE_PATH, Order::Asc)
        .order_by(POS_FROM, Order::Asc)
        .take()
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
    let target_keys = sql::query(
        conn,
        Query::select()
            .column(NoteKeys::Key)
            .from(NoteKeys::Table)
            .and_where(Expr::col(NoteKeys::NotePath).eq(path))
            .and_where(Expr::col(NoteKeys::Key).is_not_null()),
        |row| row.get(0),
    )?;

    let mut candidates: Vec<(String, String, i64)> =
        sql::query(conn, &page_sources_query(path, limit, cursor), |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })?;
    let indexed_link_count = sql::query_one(
        conn,
        links_to(path).expr(Func::count(Expr::col(Asterisk))),
        |row| row.get(0),
    )?;

    let limit = usize::try_from(limit).unwrap_or(usize::MAX);
    let has_more = candidates.len() > limit;
    candidates.truncate(limit);
    let Some((last_path, _, last_recency)) = candidates.last().cloned() else {
        return Ok(BacklinkPage {
            sources: Vec::new(),
            next_cursor: None,
            indexed_link_count,
            target_keys,
        });
    };

    let last = BacklinkSourceCursor {
        recency_ms: last_recency,
        source_path: last_path,
    };
    let positions: Vec<(String, i64)> =
        sql::query(conn, &page_positions_query(path, cursor, &last), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })?;
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
        next_cursor: has_more.then_some(last),
        indexed_link_count,
        target_keys,
    })
}
