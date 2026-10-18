//! The five commands. Shared rules live here: stdout carries only data,
//! warnings go to stderr, and `show`/`path`/`open` degrade to a file scan
//! when the index is missing or unusable (`search` is the one command that
//! requires it).

pub mod open;
pub mod path;
pub mod search;
pub mod show;
pub mod today;

mod output;

use std::fmt::Display;
use std::path::Path;

use crate::index::{open_read_only, IndexOpen, OpenIndex};

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
