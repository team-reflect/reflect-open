//! The file-change contract shared by every producer of `index:changed`: the
//! desktop watcher, the iCloud metadata watch, the iCloud conflict sweep, and
//! the X archive downloads. The frontend validates the payload with one zod
//! schema, so the shape is defined once here.

use serde::Serialize;

/// The event carrying batched [`FileChange`]s to the frontend.
pub(crate) const CHANGE_EVENT: &str = "index:changed";

/// The event asking the frontend for one full reconcile pass.
pub(crate) const RECONCILE_EVENT: &str = "index:reconcile";

/// What happened to a graph file. Serializes as `"upsert"` or `"remove"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeKind {
    /// Created or modified.
    Upsert,
    /// Deleted.
    Remove,
}

impl std::fmt::Display for ChangeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Upsert => "upsert",
            Self::Remove => "remove",
        })
    }
}

/// One changed graph file.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub kind: ChangeKind,
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
            kind: ChangeKind::Upsert,
            modified_ms,
        }
    }

    pub fn remove(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            kind: ChangeKind::Remove,
            modified_ms: None,
        }
    }
}
