//! `reflect tasks` — public-note task projection from the read-only index.

use std::collections::HashSet;

use clap::ValueEnum;

use crate::commands::open_index_required;
use crate::commands::output::{print_json, TaskJson, TasksJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::read_note;

#[derive(Clone, Copy, Debug, ValueEnum)]
pub enum State {
    Open,
    Done,
    All,
}

pub fn run(graph: &Graph, json: bool, state: State, limit: usize) -> Result<(), CliError> {
    let index = open_index_required(&graph.root)?;
    let checked_filter = match state {
        State::Open => "AND tasks.checked = 0",
        State::Done => "AND tasks.checked = 1",
        State::All => "",
    };
    let sql = format!(
        "SELECT tasks.note_path, notes.title, tasks.marker_offset, tasks.text,
                tasks.raw, tasks.checked, tasks.due_date, tasks.breadcrumbs
         FROM tasks JOIN notes ON notes.path = tasks.note_path
         WHERE notes.kind != 'template' AND notes.is_private = 0 {checked_filter}
         ORDER BY notes.updated_at DESC, tasks.note_path, tasks.marker_offset
         LIMIT ?1"
    );
    let mut statement = index.conn.prepare(&sql)?;
    let rows = statement.query_map([limit as i64], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, String>(7)?,
        ))
    })?;
    let mut public = HashSet::new();
    let mut blocked = HashSet::new();
    let mut results = Vec::new();
    for row in rows {
        let (note_path, note_title, marker_offset, text, raw, checked, due_date, breadcrumbs) =
            row?;
        if blocked.contains(&note_path) {
            continue;
        }
        if !public.contains(&note_path) {
            if read_note(&graph.root, &note_path).is_err() {
                blocked.insert(note_path);
                continue;
            }
            public.insert(note_path.clone());
        }
        let breadcrumbs = serde_json::from_str::<Vec<String>>(&breadcrumbs).unwrap_or_default();
        results.push(TaskJson {
            note_path,
            note_title,
            marker_offset,
            text,
            raw,
            checked: checked != 0,
            due_date,
            breadcrumbs,
        });
    }
    if json {
        return print_json(&TasksJson { results });
    }
    for task in results {
        let mark = if task.checked { "x" } else { " " };
        println!("- [{mark}] {}\t{}", task.text, task.note_path);
    }
    Ok(())
}
