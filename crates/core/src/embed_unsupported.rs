//! Stand-in for the embedding runtime on platforms that have none: the
//! commands stay registered so the IPC surface is identical everywhere, and
//! the status reports `unsupported` so the frontend can turn semantic search
//! off. Search stays lexical (FTS5).

use reflect_types::{AppError, AppResult, EmbedStatus};

use crate::Core;

/// Empty stand-in for the runtime state, so [`Core`] holds the same type name
/// on every platform.
#[derive(Default)]
pub struct EmbedState {}

impl Core {
    pub fn embed_status(&self) -> AppResult<EmbedStatus> {
        Ok(EmbedStatus::Unsupported)
    }

    pub async fn embed_ensure(&self) -> AppResult<EmbedStatus> {
        Ok(EmbedStatus::Unsupported)
    }

    /// Fails loudly: the frontend never embeds on an `unsupported` runtime.
    pub async fn embed_texts(&self, _texts: Vec<String>) -> AppResult<Vec<Vec<f32>>> {
        Err(AppError::Unknown {
            message: "the embedding runtime is not supported on this platform".into(),
        })
    }
}
