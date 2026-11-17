//! Reads of the `tasks` table.

use rusqlite::Connection;

use reflect_types::{AppResult, TaskRow};

/// The open (`checked = false`) or the completed tasks of every note but
/// templates, in no fixed order.
pub(crate) fn tasks(conn: &Connection, checked: bool) -> AppResult<Vec<TaskRow>> {
    let rows = conn
        .prepare_cached(
            "SELECT tasks.note_path, tasks.ast_path, tasks.markdown, tasks.breadcrumbs,
                    tasks.checked, notes.title, notes.daily_date, notes.is_pinned,
                    notes.pinned_order, notes.updated_at
             FROM tasks
             JOIN notes ON notes.path = tasks.note_path
             WHERE notes.kind != 'template' AND tasks.checked = ?1",
        )?
        .query_map([checked], |row| {
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
        })?
        .collect::<Result<_, _>>()?;
    Ok(rows)
}
