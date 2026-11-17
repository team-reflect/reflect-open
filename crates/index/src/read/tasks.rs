//! Reads of the `tasks` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Query};

use reflect_types::{AppResult, TaskRow};

use crate::schema::{Notes, Tasks};
use crate::sql::{self, lit};

/// The open (`checked = false`) or the completed tasks of every note but
/// templates, in no fixed order.
pub(crate) fn tasks(conn: &Connection, checked: bool) -> AppResult<Vec<TaskRow>> {
    sql::query(
        conn,
        Query::select()
            .columns([
                (Tasks::Table, Tasks::NotePath),
                (Tasks::Table, Tasks::AstPath),
                (Tasks::Table, Tasks::Markdown),
                (Tasks::Table, Tasks::Breadcrumbs),
                (Tasks::Table, Tasks::Checked),
            ])
            .columns([
                (Notes::Table, Notes::Title),
                (Notes::Table, Notes::DailyDate),
                (Notes::Table, Notes::IsPinned),
                (Notes::Table, Notes::PinnedOrder),
                (Notes::Table, Notes::UpdatedAt),
            ])
            .from(Tasks::Table)
            .inner_join(
                Notes::Table,
                Expr::col((Notes::Table, Notes::Path)).equals((Tasks::Table, Tasks::NotePath)),
            )
            .and_where(Expr::col((Notes::Table, Notes::Kind)).ne(lit("template")))
            // In the text, so the partial indexes on `checked` apply.
            .and_where(Expr::col((Tasks::Table, Tasks::Checked)).eq(lit(i32::from(checked)))),
        |row| {
            Ok(TaskRow {
                note_path: row.get(0)?,
                ast_path: row.get(1)?,
                markdown: row.get(2)?,
                breadcrumbs: row.get(3)?,
                checked: row.get(4)?,
                note_title: row.get(5)?,
                daily_date: row.get(6)?,
                is_pinned: row.get(7)?,
                pinned_order: row.get(8)?,
                updated_at: row.get(9)?,
            })
        },
    )
}
