//! The shared error contract returned by every `#[tauri::command]`.
//!
//! Serializes to `{ "kind": "...", "message": "..." }` — matching the zod
//! `AppError` discriminated union in `@reflect/core`, so the frontend can branch
//! on `kind` with a type guard instead of inspecting opaque strings.

use serde::Serialize;

// The enum mirrors the full TS `AppError` contract. Some variants (`Parse`,
// `Unknown`) are only produced on the TypeScript boundary, so Rust never
// constructs them — keep them for contract parity.
#[allow(dead_code)]
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppError {
    /// Filesystem / IO failure.
    Io { message: String },
    /// A requested note or file does not exist.
    NotFound { message: String },
    /// A path escaped the graph root (security guard).
    Traversal { message: String },
    /// An operation needs an open graph but none is set.
    NoGraph { message: String },
    /// Parse / validation failure.
    Parse { message: String },
    /// Anything not covered above.
    Unknown { message: String },
}

impl AppError {
    pub fn io(message: impl Into<String>) -> Self {
        Self::Io {
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound {
            message: message.into(),
        }
    }

    pub fn traversal(message: impl Into<String>) -> Self {
        Self::Traversal {
            message: message.into(),
        }
    }

    pub fn parse(message: impl Into<String>) -> Self {
        Self::Parse {
            message: message.into(),
        }
    }

    pub fn no_graph() -> Self {
        Self::NoGraph {
            message: "No graph is open".into(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        if err.kind() == std::io::ErrorKind::NotFound {
            Self::NotFound {
                message: err.to_string(),
            }
        } else {
            Self::Io {
                message: err.to_string(),
            }
        }
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        Self::Io {
            message: err.to_string(),
        }
    }
}

/// Result alias for command and helper functions.
pub type AppResult<T> = Result<T, AppError>;
