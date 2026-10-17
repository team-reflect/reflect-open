//! The file-change contract shared by every producer of `index:changed`: the
//! desktop watcher, the iCloud metadata watch, the iCloud conflict sweep, and
//! the X archive downloads. The frontend validates the payload with one zod
//! schema, so the shape is defined once here.

use serde::Serialize;

/// The event carrying batched [`FileChange`]s to the frontend.
pub(crate) const CHANGE_EVENT: &str = "index:changed";

/// The event asking the frontend for one full reconcile pass.
pub(crate) const RECONCILE_EVENT: &str = "index:reconcile";

/// One changed graph file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    /// `"upsert"` (created/modified) or `"remove"` (deleted).
    pub kind: String,
    /// Last-modified time in epoch milliseconds, set for upserts. The frontend
    /// stamps `notes.mtime` from this — without it, watcher-indexed rows would
    /// carry no real timestamp (and reconcile would never repair them, since it
    /// is content-hash gated).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_ms: Option<u64>,
}

impl FileChange {
    pub fn upsert(path: impl Into<String>, modified_ms: Option<u64>) -> Self {
        Self {
            path: path.into(),
            kind: "upsert".into(),
            modified_ms,
        }
    }

    pub fn remove(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind: "remove".into(),
            modified_ms: None,
        }
    }
}
