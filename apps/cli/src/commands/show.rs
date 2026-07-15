//! `reflect show <note>` — resolve by date, path, title, or alias and print
//! the raw markdown. Resolution reads the live files directly so external
//! edits never wait for the derived index to catch up.

use crate::commands::output::{print_content, print_json, NoteJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::note_file::read_note;
use crate::paths::date_from_daily_path;
use crate::resolve::{resolve_note, ResolvedNote};

pub fn run(graph: &Graph, json: bool, note_arg: &str) -> Result<(), CliError> {
    let resolved = resolve_note(note_arg, &graph.root)?;

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
