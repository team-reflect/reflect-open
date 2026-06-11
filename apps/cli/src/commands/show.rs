//! `reflect show <note>` — resolve by date, path, title, or alias and print
//! the raw markdown. Index-assisted when the index is present; file-scan
//! fallback when it isn't (the command works with no index at all).

use crate::commands::open_index_for_resolution;
use crate::commands::output::{print_content, print_json, NoteJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::read_note;
use crate::paths::date_from_daily_path;
use crate::resolve::{resolve_note, ResolvedNote};

pub fn run(graph: &Graph, json: bool, note_arg: &str) -> Result<(), CliError> {
    let index = open_index_for_resolution(&graph.root);
    let resolved = resolve_note(note_arg, &graph.root, index.as_ref().map(|open| &open.conn))?;

    if let ResolvedNote::Daily { date, rel_path } = &resolved {
        if !graph.root.join(rel_path).is_file() {
            return Err(CliError::NotFound(format!(
                "no daily note for {date} ({rel_path})"
            )));
        }
    }

    let rel_path = resolved.rel_path();
    let note = read_note(&graph.root, rel_path)?;
    if json {
        return print_json(&NoteJson {
            date: date_from_daily_path(rel_path),
            path: rel_path,
            absolute_path: graph.root.join(rel_path).display().to_string(),
            title: &note.meta.title,
            content: &note.content,
        });
    }
    print_content(&note.content);
    Ok(())
}
