//! Stand-in for the embedding runtime on platforms that have none: the
//! commands stay registered so the IPC surface is identical everywhere, and
//! the status reports `unsupported` so the frontend can turn semantic search
//! off. Search stays lexical (FTS5).

use reflect_types::{AppError, AppResult};
use serde::Serialize;

use crate::Core;

/// Unit stand-in for the runtime state, so [`Core`] holds the same type name
/// on every platform.
#[derive(Default)]
pub struct EmbedState;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum EmbedStatus {
    /// This platform has no embedding runtime.
    Unsupported,
}

impl Core {
    pub fn embed_status(&self) -> AppResult<EmbedStatus> {
        Ok(EmbedStatus::Unsupported)
    }

    pub fn embed_ensure(&self) -> AppResult<EmbedStatus> {
        Ok(EmbedStatus::Unsupported)
    }

    /// Fails loudly: the frontend never embeds on an `unsupported` runtime.
    pub fn embed_texts(&self) -> AppResult<()> {
        Err(AppError::Unknown {
            message: "the embedding runtime is not supported on this platform".into(),
        })
    }
}
