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
    /// A remote rejected our credentials (token invalid/expired/insufficient).
    Auth { message: String },
    /// The remote is unreachable (offline, DNS, timeout) — retryable.
    Network { message: String },
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

impl From<git2::Error> for AppError {
    fn from(err: git2::Error) -> Self {
        use git2::{ErrorClass, ErrorCode};
        let message = err.message().to_string();
        // libgit2 reports HTTP auth failures inconsistently (code vs class vs
        // message), so classify with all three; Net class is reliably "couldn't
        // reach the remote" and maps to the retryable Network kind. The HTTP
        // matches anchor on libgit2's "… status code: NNN" phrasing so a 401/403
        // appearing in arbitrary content (an oid, a filename) can't false-match.
        // Known ambiguity, accepted: GitHub can also answer 403 for secondary
        // rate limits; at the transport layer that's indistinguishable from a
        // rejected credential without the response body. Misclassification is
        // not sticky — the auth state never blocks the next cycle's retry.
        let lowered = message.to_lowercase();
        if err.code() == ErrorCode::Auth
            || lowered.contains("status code: 401")
            || lowered.contains("status code: 403")
            || lowered.contains("authentication")
            || lowered.contains("authorization")
        {
            return Self::Auth { message };
        }
        if err.class() == ErrorClass::Net {
            return Self::Network { message };
        }
        Self::Io { message }
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

#[cfg(test)]
mod tests {
    use super::AppError;
    use git2::{ErrorClass, ErrorCode};

    fn classify(code: ErrorCode, class: ErrorClass, message: &str) -> AppError {
        AppError::from(git2::Error::new(code, class, message))
    }

    #[test]
    fn git_auth_failures_classify_as_auth() {
        let cases = [
            classify(ErrorCode::Auth, ErrorClass::Http, "authentication required"),
            classify(
                ErrorCode::GenericError,
                ErrorClass::Http,
                "unexpected http status code: 401",
            ),
            classify(
                ErrorCode::GenericError,
                ErrorClass::Http,
                "request failed with status code: 403",
            ),
        ];
        for error in cases {
            assert!(matches!(error, AppError::Auth { .. }), "{error:?}");
        }
    }

    #[test]
    fn git_network_failures_classify_as_network() {
        let error = classify(
            ErrorCode::GenericError,
            ErrorClass::Net,
            "failed to resolve address for github.com",
        );
        assert!(matches!(error, AppError::Network { .. }), "{error:?}");
    }

    #[test]
    fn other_git_failures_classify_as_io() {
        let error = classify(ErrorCode::NotFound, ErrorClass::Odb, "object not found");
        assert!(matches!(error, AppError::Io { .. }), "{error:?}");
    }

    #[test]
    fn incidental_status_code_digits_do_not_classify_as_auth() {
        // "403" inside an oid/filename must not read as an HTTP status.
        let error = classify(
            ErrorCode::NotFound,
            ErrorClass::Odb,
            "object 403fa1b2 not found",
        );
        assert!(matches!(error, AppError::Io { .. }), "{error:?}");
    }
}
