//! Reads of the daily notes.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Order, Query};

use reflect_types::{AppResult, DailyNoteRow};

use crate::schema::Notes;
use crate::sql::{self, lit};

/// The dates in `start..=end` whose daily note has content, ascending.
pub(crate) fn dates_in_range(conn: &Connection, start: &str, end: &str) -> AppResult<Vec<String>> {
    sql::query(
        conn,
        Query::select()
            .column(Notes::DailyDate)
            .from(Notes::Table)
            .and_where(Expr::col(Notes::DailyDate).is_not_null())
            .and_where(Expr::col(Notes::DailyDate).gte(start))
            .and_where(Expr::col(Notes::DailyDate).lte(end))
            .and_where(Expr::col(Notes::HasContent).eq(lit(1)))
            .order_by(Notes::DailyDate, Order::Asc),
        |row| row.get(0),
    )
}

/// The non-private daily notes in `start..=end`, newest first, at most
/// `limit`.
pub(crate) fn notes_in_range(
    conn: &Connection,
    start: &str,
    end: &str,
    limit: u32,
) -> AppResult<Vec<DailyNoteRow>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                Notes::Path,
                Notes::Title,
                Notes::DailyDate,
                Notes::Preview,
                Notes::Mtime,
                Notes::IsPrivate,
            ])
            .from(Notes::Table)
            .and_where(Expr::col(Notes::DailyDate).is_not_null())
            .and_where(Expr::col(Notes::DailyDate).gte(start))
            .and_where(Expr::col(Notes::DailyDate).lte(end))
            .and_where(Expr::col(Notes::IsPrivate).eq(lit(0)))
            .order_by(Notes::DailyDate, Order::Desc)
            .limit(u64::from(limit)),
        |row| {
            Ok(DailyNoteRow {
                path: row.get(0)?,
                title: row.get(1)?,
                daily_date: row.get(2)?,
                preview: row.get(3)?,
                mtime: row.get(4)?,
                is_private: row.get(5)?,
            })
        },
    )
}
