//! The JSON that crosses the C interface of `reflect-ffi` (Swift and Rust).

use serde::{Deserialize, Serialize};

/// The directories and user agent the iOS shell starts the core with.
#[derive(Debug, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CoreStartConfig {
    pub app_data_dir: Option<String>,
    pub document_dir: Option<String>,
    pub user_agent: Option<String>,
}

/// The answer to a `reflect-asset` request.
#[derive(Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AssetResolveReply {
    /// Serve the file at the absolute `path`. `range` selects bytes; `None`
    /// serves the whole file.
    File {
        path: String,
        mime: String,
        total: u64,
        range: Option<ByteRange>,
    },
    /// Refuse the request with an HTTP status. `total` is the length of the
    /// file, for the `Content-Range` of a 416.
    Refused { status: u16, total: Option<u64> },
}

/// The first and last byte of a single-range `Range` header.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
pub struct ByteRange {
    pub start: u64,
    pub end: u64,
}
