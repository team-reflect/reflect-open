//! `reflect today` — print today's daily note. File-only: resolved straight
//! from the local date and the `daily/YYYY-MM-DD.md` convention, no index.

use crate::commands::output::{print_content, print_json, NoteJson, PathJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::{ensure_not_private, read_note};
use crate::paths::{daily_path, today_date};

pub fn run(graph: &Graph, json: bool, path_only: bool) -> Result<(), CliError> {
    let date = today_date();
    let rel_path = daily_path(&date);
    let absolute = graph.root.join(&rel_path);

    if path_only {
        // Dailies are created lazily, so the path is printed even when the
        // file doesn't exist yet — that's how editors/scripts create it.
        ensure_not_private(&graph.root, &rel_path)?;
        if json {
            return print_json(&PathJson {
                date: Some(&date),
                path: &rel_path,
                absolute_path: absolute.display().to_string(),
                exists: absolute.is_file(),
            });
        }
        println!("{}", absolute.display());
        return Ok(());
    }

    if !absolute.is_file() {
        return Err(CliError::NotFound(format!(
            "no daily note for {date} yet (would be {rel_path})"
        )));
    }
    let note = read_note(&graph.root, &rel_path)?;
    if json {
        return print_json(&NoteJson {
            date: Some(&date),
            path: &rel_path,
            absolute_path: absolute.display().to_string(),
            title: &note.meta.title,
            content: &note.content,
        });
    }
    print_content(&note.content);
    Ok(())
}
