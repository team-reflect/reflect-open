//! Local embedding runtime commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::embed::EmbedStatus;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub fn embed_status(core: State<'_, Arc<Core>>) -> AppResult<EmbedStatus> {
    core.embed_status()
}

#[tauri::command]
pub async fn embed_ensure(core: State<'_, Arc<Core>>) -> AppResult<EmbedStatus> {
    core.embed_ensure().await
}

#[tauri::command]
pub async fn embed_texts(
    texts: Vec<String>,
    core: State<'_, Arc<Core>>,
) -> AppResult<Vec<Vec<f32>>> {
    core.embed_texts(texts).await
}
