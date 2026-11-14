//! The embedding runtime's status.

use serde::Serialize;

/// Byte counts for an active model download. Absent until the download
/// starts (cache probing, or a cached model that skips downloading); after
/// the last byte it stays at 100% through the model-load phase.
#[derive(Clone, Copy, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct EmbedProgress {
    pub downloaded: u64,
    pub total: u64,
}

#[derive(Clone, Serialize)]
#[cfg_attr(feature = "codegen", derive(specta::Type))]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "status"
)]
pub enum EmbedStatus {
    /// No model loaded yet; `embed_ensure` will download/load it.
    Uninitialized,
    /// Download/load in progress (first run downloads ~90MB). The runtime
    /// keeps the latest byte counts, so polls and `embed:status` events
    /// report the same progress.
    Loading {
        #[serde(skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", specta(type = EmbedProgress))]
        progress: Option<EmbedProgress>,
    },
    /// `embed_texts` is ready; `model` is recorded per vector (rebuild key).
    Ready { model: String },
    /// Load failed; semantic search is unavailable (lexical still works).
    Failed { message: String },
    /// This platform or CPU has no embedding runtime.
    Unsupported,
}
