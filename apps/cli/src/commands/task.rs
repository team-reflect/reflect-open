//! `reflect task <text>` — append a round Reflect task to a note.

use crate::commands::append::append_to_note;
use crate::commands::output::{print_json, MutationJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::paths::{parse_calendar_date, today_date};

pub fn run(
    graph: &Graph,
    json: bool,
    text: &str,
    note: Option<&str>,
    due: Option<&str>,
    expected_hash: Option<&str>,
) -> Result<(), CliError> {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return Err(CliError::runtime("task text must not be empty"));
    }
    if let Some(due) = due {
        if parse_calendar_date(due).is_none() {
            return Err(CliError::runtime(format!("invalid due date: {due}")));
        }
    }
    let due_suffix = due.map(|date| format!(" [[{date}]]")).unwrap_or_default();
    let block = format!("+ [ ] {text}{due_suffix}");
    let default_note = today_date();
    let (path, hash) = append_to_note(graph, note.unwrap_or(&default_note), block, expected_hash)?;
    let output = MutationJson {
        action: "task",
        absolute_path: graph.root.join(&path).display().to_string(),
        path,
        hash,
        previous_path: None,
        trash_path: None,
    };
    if json {
        print_json(&output)
    } else {
        println!("{}", output.path);
        Ok(())
    }
}
