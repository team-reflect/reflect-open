//! Reads of the durable `note_visits` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Order, Query};

use reflect_types::{AppResult, VisitedNote};

use crate::schema::{NoteVisits, Notes};
use crate::sql::{self, lit};

/// The notes this device opened, most recent first, at most `limit`. Daily
/// notes, templates, and deleted notes are left out.
pub(crate) fn visited_notes(conn: &Connection, limit: u32) -> AppResult<Vec<VisitedNote>> {
    sql::query(
        conn,
        Query::select()
            .columns([(Notes::Table, Notes::Path), (Notes::Table, Notes::Title)])
            .from(NoteVisits::Table)
            .inner_join(
                Notes::Table,
                Expr::col((Notes::Table, Notes::Path))
                    .equals((NoteVisits::Table, NoteVisits::Path)),
            )
            .and_where(Expr::col((Notes::Table, Notes::Kind)).eq(lit("note")))
            .order_by((NoteVisits::Table, NoteVisits::VisitedMs), Order::Desc)
            .limit(u64::from(limit)),
        |row| {
            Ok(VisitedNote {
                path: row.get(0)?,
                title: row.get(1)?,
            })
        },
    )
}
