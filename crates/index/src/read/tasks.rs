//! Reads of the `tasks` table.

use rusqlite::Connection;
use sea_query::{Expr, ExprTrait, Order, Query};

use reflect_types::{AppResult, NoteTasks, TaskRow};

use crate::schema::{Notes, Tasks};
use crate::sql::{self, lit};

/// The tasks of every note but templates, grouped by note. `checked` keeps
/// only the open (`false`) or the completed tasks, and `paths` only the tasks
/// of those notes; a note with no such task is absent from the result. A task
/// whose address or breadcrumbs do not decode is logged and left out.
pub(crate) fn tasks(
    conn: &Connection,
    checked: Option<bool>,
    paths: Option<&[String]>,
) -> AppResult<Vec<NoteTasks>> {
    let mut notes: Vec<NoteTasks> = Vec::new();
    let mut select = Query::select();
    select
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
        .order_by((Tasks::Table, Tasks::NotePath), Order::Asc);
    if let Some(checked) = checked {
        // In the text, so the partial indexes on `checked` apply.
        select.and_where(Expr::col((Tasks::Table, Tasks::Checked)).eq(lit(i32::from(checked))));
    }
    if let Some(paths) = paths {
        select.and_where(
            Expr::col((Tasks::Table, Tasks::NotePath)).in_subquery(sql::json_values(paths)?),
        );
    }
    sql::query::<(), ()>(conn, &select, |row| {
        let path: String = row.get(0)?;
        let ast_path: String = row.get(1)?;
        let breadcrumbs: String = row.get(3)?;
        let (Some(ast_path), Ok(breadcrumbs)) = (
            decode_ast_path(&ast_path),
            serde_json::from_str(&breadcrumbs),
        ) else {
            tracing::error!(path, ast_path, "skipping an unreadable task row");
            return Ok(());
        };
        let task = TaskRow {
            ast_path,
            markdown: row.get(2)?,
            breadcrumbs,
            checked: row.get(4)?,
        };
        match notes.last_mut() {
            Some(note) if note.path == path => note.tasks.push(task),
            _ => notes.push(NoteTasks {
                path,
                title: row.get(5)?,
                daily_date: row.get(6)?,
                is_pinned: row.get(7)?,
                pinned_order: row.get(8)?,
                updated_at: row.get(9)?,
                hash: row.get(10)?,
                tasks: vec![task],
            }),
        }
        Ok(())
    })?;
    Ok(notes)
}

/// The address in the stored JSON text: a non-empty array of indexes.
fn decode_ast_path(column: &str) -> Option<Vec<u32>> {
    serde_json::from_str::<Vec<u32>>(column)
        .ok()
        .filter(|path| !path.is_empty())
}
