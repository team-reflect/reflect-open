//! `reflect append <note>` — append a Markdown block atomically.

use crate::commands::open_index_for_resolution;
use crate::commands::output::{print_json, MutationJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::mutation::{atomic_create, atomic_replace, payload};
use crate::resolve::resolve_note;

fn with_appended_block(source: &str, block: &str) -> String {
    let block = block.trim_end_matches(['\r', '\n']);
    if source.is_empty() {
        return format!("{block}\n");
    }
    let mut next = source.trim_end_matches(['\r', '\n']).to_string();
    next.push_str("\n\n");
    next.push_str(block);
    next.push('\n');
    next
}

pub(crate) fn append_to_note(
    graph: &Graph,
    note_arg: &str,
    block: String,
    expected_hash: Option<&str>,
) -> Result<(String, String), CliError> {
    if block.trim().is_empty() {
        return Err(CliError::runtime("appended content must not be empty"));
    }
    let index = open_index_for_resolution(&graph.root);
    let resolved = resolve_note(note_arg, &graph.root, index.as_ref().map(|open| &open.conn))?;
    let path = resolved.rel_path().to_string();
    let absolute = graph.root.join(&path);
    if !absolute.exists() {
        if !path.starts_with("daily/") {
            return Err(CliError::NotFound(format!("note does not exist: {path}")));
        }
        if expected_hash.is_some() {
            return Err(CliError::Conflict(format!(
                "cannot match --expect-hash because {path} does not exist"
            )));
        }
        let source = with_appended_block("", &block);
        let hash = atomic_create(&graph.root, &path, &source)?;
        return Ok((path, hash));
    }
    let source = crate::mutation::read_for_mutation(&graph.root, &path, expected_hash)?;
    let next = with_appended_block(&source, &block);
    let hash = atomic_replace(&graph.root, &path, &next, expected_hash)?;
    Ok((path, hash))
}

pub fn run(
    graph: &Graph,
    json: bool,
    note_arg: &str,
    text: Option<String>,
    stdin: bool,
    expected_hash: Option<&str>,
) -> Result<(), CliError> {
    let block = payload(text, stdin, "text")?;
    let (path, hash) = append_to_note(graph, note_arg, block, expected_hash)?;
    let output = MutationJson {
        action: "append",
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
