//! `reflect delete <note>` — recoverably move a public note to graph-local trash.

use crate::commands::output::{print_json, MutationJson};
use crate::commands::resolve_public_note;
use crate::error::CliError;
use crate::graph::Graph;
use crate::mutation::trash_note;

pub fn run(
    graph: &Graph,
    json: bool,
    note_arg: &str,
    expected_hash: Option<&str>,
) -> Result<(), CliError> {
    let path = resolve_public_note(graph, note_arg)?;
    let (trash_path, hash) = trash_note(&graph.root, &path, expected_hash)?;
    let output = MutationJson {
        action: "delete",
        absolute_path: graph.root.join(&trash_path).display().to_string(),
        path: path.clone(),
        hash,
        previous_path: Some(path),
        trash_path: Some(trash_path),
    };
    if json {
        print_json(&output)
    } else {
        println!("{}", output.trash_path.as_deref().unwrap_or_default());
        Ok(())
    }
}
