//! The CLI's error contract: every failure maps to a documented exit code
//! (see `docs/cli.md`). stdout carries only data; messages go to stderr.

use std::fmt;

/// Exit codes: `0` ok · `1` runtime error · `2` usage (clap) · `3` not found
/// or private · `4` index missing/unusable (`search` only).
#[derive(Debug)]
pub enum CliError {
    /// IO/SQL/graph-resolution failures (exit 1).
    Runtime(String),
    /// The note (or today's daily) does not exist (exit 3).
    NotFound(String),
    /// The note exists but carries `private: true` (exit 3 — indistinguishable
    /// from not-found by exit code; the stderr message says why).
    Private(String),
    /// `search` needs the index and it is missing or unusable (exit 4).
    NoIndex(String),
}

impl CliError {
    pub fn runtime(message: impl Into<String>) -> Self {
        CliError::Runtime(message.into())
    }

    pub fn exit_code(&self) -> u8 {
        match self {
            CliError::Runtime(_) => 1,
            CliError::NotFound(_) | CliError::Private(_) => 3,
            CliError::NoIndex(_) => 4,
        }
    }
}

impl fmt::Display for CliError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CliError::Runtime(message)
            | CliError::NotFound(message)
            | CliError::Private(message)
            | CliError::NoIndex(message) => write!(formatter, "{message}"),
        }
    }
}

impl std::error::Error for CliError {}

impl From<std::io::Error> for CliError {
    fn from(err: std::io::Error) -> Self {
        CliError::Runtime(err.to_string())
    }
}

impl From<rusqlite::Error> for CliError {
    fn from(err: rusqlite::Error) -> Self {
        CliError::Runtime(err.to_string())
    }
}
