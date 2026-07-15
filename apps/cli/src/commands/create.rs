//! `reflect create <title>` — atomically create a regular note.

use crate::commands::output::{print_json, MutationJson};
use crate::error::CliError;
use crate::graph::Graph;
use crate::mutation::{atomic_create, payload};
use crate::slug::slug_for_title;

const MAX_ATTEMPTS: usize = 1000;

fn source(title: &str, body: &str) -> String {
    let id = ulid::Ulid::new().to_string().to_lowercase();
    let body = body.trim();
    if body.is_empty() {
        format!("---\nid: {id}\n---\n# {title}\n")
    } else {
        format!("---\nid: {id}\n---\n# {title}\n\n{body}\n")
    }
}

pub fn run(
    graph: &Graph,
    json: bool,
    title: &str,
    path: Option<&str>,
    body: Option<String>,
    stdin: bool,
) -> Result<(), CliError> {
    let title = title.trim();
    if title.is_empty() || title.contains(['\r', '\n']) {
        return Err(CliError::runtime("note title must be one non-empty line"));
    }
    let body = if body.is_some() || stdin {
        payload(body, stdin, "body")?
    } else {
        String::new()
    };
    let source = source(title, &body);
    let (path, hash) = if let Some(path) = path {
        (path.to_string(), atomic_create(&graph.root, path, &source)?)
    } else {
        let slug = slug_for_title(title);
        let mut created = None;
        for ordinal in 1..=MAX_ATTEMPTS {
            let suffix = if ordinal == 1 {
                slug.clone()
            } else {
                format!("{slug}-{ordinal}")
            };
            let candidate = format!("notes/{suffix}.md");
            match atomic_create(&graph.root, &candidate, &source) {
                Ok(hash) => {
                    created = Some((candidate, hash));
                    break;
                }
                Err(CliError::Conflict(_)) => continue,
                Err(error) => return Err(error),
            }
        }
        created.ok_or_else(|| CliError::Conflict("could not claim a free note path".to_string()))?
    };
    let output = MutationJson {
        action: "create",
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
