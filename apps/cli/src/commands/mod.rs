//! Reflect graph commands. Shared rules live here: stdout carries only data,
//! warnings go to stderr, and note resolution degrades to a file scan when
//! the index is missing or unusable. Relationship and projection commands
//! require the read-only index.

pub mod append;
pub mod backlinks;
pub mod create;
pub mod delete;
pub mod list;
pub mod move_note;
pub mod open;
pub mod path;
pub mod restore;
pub mod search;
pub mod show;
pub mod tags;
pub mod task;
pub mod tasks;
pub mod today;
pub mod write;

mod output;

use std::fmt::Display;
use std::path::Path;

use crate::index::{open_read_only, IndexOpen, OpenIndex};
use crate::note_file::read_note;
use crate::resolve::resolve_note;

fn warn(message: impl Display) {
    eprintln!("reflect: warning: {message}");
}

/// Open the index for `show`/`path` resolution; a missing or unusable index
/// is not fatal there — resolution falls back to scanning the files.
fn open_index_for_resolution(root: &Path) -> Option<OpenIndex> {
    match open_read_only(root) {
        IndexOpen::Opened(open) => {
            if open.newer_schema {
                warn("the index schema is newer than this CLI — update Reflect");
            }
            Some(open)
        }
        IndexOpen::Missing => None,
        IndexOpen::Unusable(message) => {
            warn(format!("{message}; falling back to a file scan"));
            None
        }
    }
}

/// Open the read-only index for commands whose relationship/projection data
/// cannot be reconstructed cheaply from individual markdown files.
pub(crate) fn open_index_required(root: &Path) -> Result<OpenIndex, crate::error::CliError> {
    match open_read_only(root) {
        IndexOpen::Opened(open) => {
            if open.newer_schema {
                warn("the index schema is newer than this CLI — update Reflect");
            }
            Ok(open)
        }
        IndexOpen::Missing => Err(crate::error::CliError::NoIndex(
            "no search index — open this graph in Reflect to build it".to_string(),
        )),
        IndexOpen::Unusable(message) => Err(crate::error::CliError::NoIndex(message)),
    }
}

/// Resolve a note reference and enforce existence + live privacy before a
/// command reads relationships or mutates the file.
pub(crate) fn resolve_public_note(
    graph: &crate::graph::Graph,
    note_arg: &str,
) -> Result<String, crate::error::CliError> {
    let index = open_index_for_resolution(&graph.root);
    let resolved = resolve_note(note_arg, &graph.root, index.as_ref().map(|open| &open.conn))?;
    let path = resolved.rel_path().to_string();
    if !graph.root.join(&path).is_file() {
        return Err(crate::error::CliError::NotFound(format!(
            "note does not exist: {path}"
        )));
    }
    read_note(&graph.root, &path)?;
    Ok(path)
}
