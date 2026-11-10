//! Stand-in for the embedding runtime on platforms that have none: the
//! commands stay registered so the IPC surface is identical everywhere, and
//! the status reports `unsupported` so the frontend can turn semantic search
//! off. Search stays lexical (FTS5).

use serde::Serialize;

use crate::error::{AppError, AppResult};

/// Unit stand-in for the runtime state, so `lib.rs` manages the same type
/// name on every platform.
#[derive(Default)]
pub struct EmbedState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum EmbedStatus {
    /// This platform has no embedding runtime.
    Unsupported,
}

#[tauri::command]
pub fn embed_status() -> AppResult<EmbedStatus> {
    Ok(EmbedStatus::Unsupported)
}

#[tauri::command]
pub fn embed_ensure() -> AppResult<EmbedStatus> {
    Ok(EmbedStatus::Unsupported)
}

/// Fails loudly: the frontend never embeds on an `unsupported` runtime.
#[tauri::command]
pub fn embed_texts() -> AppResult<()> {
    Err(AppError::Unknown {
        message: "the embedding runtime is not supported on this platform".into(),
    })
}
