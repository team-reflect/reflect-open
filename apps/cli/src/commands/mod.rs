//! The five commands. Shared rules live here: stdout carries only data,
//! warnings go to stderr. `show`/`path`/`open` resolve against live files;
//! `search` is the one command that reads and requires the derived index.

pub mod open;
pub mod path;
pub mod search;
pub mod show;
pub mod today;

mod output;

use std::fmt::Display;
fn warn(message: impl Display) {
    eprintln!("reflect: warning: {message}");
}
