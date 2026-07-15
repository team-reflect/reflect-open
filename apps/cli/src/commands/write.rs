//! `reflect write <note>` — replace a public note's full Markdown source.

use crate::commands::output::{print_json, MutationJson};
use crate::commands::resolve_public_note;
use crate::error::CliError;
use crate::graph::Graph;
use crate::mutation::{atomic_replace, payload};

pub fn run(
    graph: &Graph,
    json: bool,
    note_arg: &str,
    content: Option<String>,
    stdin: bool,
    expected_hash: Option<&str>,
) -> Result<(), CliError> {
    let path = resolve_public_note(graph, note_arg)?;
    let content = payload(content, stdin, "content")?;
    let hash = atomic_replace(&graph.root, &path, &content, expected_hash)?;
    let output = MutationJson {
        action: "write",
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
