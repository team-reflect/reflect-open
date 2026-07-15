//! `reflect restore <trash-path>` — restore a note from graph-local trash.

use crate::commands::output::{print_json, MutationJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::mutation::restore_note;

pub fn run(graph: &Graph, json: bool, trash_path: &str, to: Option<&str>) -> Result<(), CliError> {
    let (path, hash) = restore_note(&graph.root, trash_path, to)?;
    let output = MutationJson {
        action: "restore",
        absolute_path: graph.root.join(&path).display().to_string(),
        path,
        hash,
        previous_path: None,
        trash_path: Some(trash_path.to_string()),
    };
    if json {
        print_json(&output)
    } else {
        println!("{}", output.path);
        Ok(())
    }
}
