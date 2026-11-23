//! Reads of the `tasks` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Query};

use reflect_types::{AppResult, TaskRow, TaskRows};

use crate::read::meta::commit_seq;
use crate::schema::{Notes, Tasks};
use crate::sql::{self, lit};

/// The open (`checked = false`) or the completed tasks of every note but
/// templates, in no fixed order, with the commit sequence of the index. The
/// caller runs this in one read transaction, so both come from one state. A
/// row whose address or breadcrumbs do not decode is logged and left out.
pub(crate) fn tasks(conn: &Connection, checked: bool) -> AppResult<TaskRows> {
    let seq = commit_seq(conn)?;
    let rows: Vec<Option<TaskRow>> = sql::query(
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
                (Notes::Table, Notes::FileHash),
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
            let note_path: String = row.get(0)?;
            let ast_path: String = row.get(1)?;
            let breadcrumbs: String = row.get(3)?;
            let (Some(ast_path), Ok(breadcrumbs)) =
                (decode_ast_path(&ast_path), serde_json::from_str(&breadcrumbs))
            else {
                tracing::error!(note_path, ast_path, "skipping an unreadable task row");
                return Ok(None);
            };
            Ok(Some(TaskRow {
                note_path,
                ast_path,
                markdown: row.get(2)?,
                breadcrumbs,
                checked: row.get(4)?,
                note_title: row.get(5)?,
                daily_date: row.get(6)?,
                is_pinned: row.get(7)?,
                pinned_order: row.get(8)?,
                updated_at: row.get(9)?,
                note_hash: row.get(10)?,
            }))
        },
    )?;
    Ok(TaskRows {
        seq,
        rows: rows.into_iter().flatten().collect(),
    })
}

/// The address in the stored JSON text: a non-empty array of indexes.
fn decode_ast_path(column: &str) -> Option<Vec<u32>> {
    serde_json::from_str::<Vec<u32>>(column)
        .ok()
        .filter(|path| !path.is_empty())
}
