use serde::Serialize;

/// Metadata for a file inside the graph.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    /// Graph-relative path, forward-slashed.
    pub path: String,
    pub size: u64,
    /// Last-modified time in epoch milliseconds.
    pub modified_ms: u64,
    /// True when the file is iCloud-evicted: the note exists but its content
    /// is not on disk until re-downloaded. Consumers must not read it — a
    /// read blocks on an on-demand download — and must not treat it as
    /// deleted (Plan 21). Covers both eviction forms: for a legacy `.icloud`
    /// stub, `size` and `modified_ms` describe the stub; for a modern
    /// dataless file they are the real (preserved) values.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub placeholder: bool,
}
