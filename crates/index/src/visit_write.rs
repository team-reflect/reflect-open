//! The write path of the durable `note_visits` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, OnConflict, Order, Query};

use reflect_types::AppResult;

use crate::schema::NoteVisits;
use crate::sql;

/// How many visits the table keeps; older ones are deleted on each write.
const MAX_VISITS: u64 = 200;

/// Upserts the visit of `path`, then deletes all but the newest
/// [`MAX_VISITS`] visits.
pub(super) fn record(conn: &Connection, path: &str, visited_ms: i64) -> AppResult<()> {
    sql::execute(
        conn,
        Query::insert()
            .into_table(NoteVisits::Table)
            .columns([NoteVisits::Path, NoteVisits::VisitedMs])
            .values_panic([path.into(), visited_ms.into()])
            .on_conflict(
                OnConflict::column(NoteVisits::Path)
                    .update_column(NoteVisits::VisitedMs)
                    .to_owned(),
            ),
    )?;
    let newest = Query::select()
        .column(NoteVisits::Path)
        .from(NoteVisits::Table)
        .order_by(NoteVisits::VisitedMs, Order::Desc)
        .limit(MAX_VISITS)
        .take();
    sql::execute(
        conn,
        Query::delete()
            .from_table(NoteVisits::Table)
            .and_where(Expr::col(NoteVisits::Path).not_in_subquery(newest)),
    )?;
    Ok(())
}

/// Deletes the visit of `path`, so a later note at that path starts without one.
pub(super) fn remove(conn: &Connection, path: &str) -> AppResult<()> {
    sql::execute(
        conn,
        Query::delete()
            .from_table(NoteVisits::Table)
            .and_where(Expr::col(NoteVisits::Path).eq(path)),
    )?;
    Ok(())
}
