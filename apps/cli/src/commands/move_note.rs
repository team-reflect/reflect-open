//! `reflect move <note> <destination>` — move a public note without rewriting content.

use crate::commands::output::{print_json, MutationJson};
use crate::commands::resolve_public_note;
use crate::error::CliError;
use crate::graph::Graph;
use crate::mutation::move_note;

pub fn run(
    graph: &Graph,
    json: bool,
    note_arg: &str,
    destination: &str,
    expected_hash: Option<&str>,
) -> Result<(), CliError> {
    let from = resolve_public_note(graph, note_arg)?;
    let hash = move_note(&graph.root, &from, destination, expected_hash)?;
    let output = MutationJson {
        action: "move",
        absolute_path: graph.root.join(destination).display().to_string(),
        path: destination.to_string(),
        hash,
        previous_path: Some(from),
        trash_path: None,
    };
    if json {
        print_json(&output)
    } else {
        println!("{}", output.path);
        Ok(())
    }
}
