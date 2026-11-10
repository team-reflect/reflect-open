//! Stand-in embedding commands for platforms with no embedding runtime,
//! forwarded to [`reflect_core::Core`].

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
pub fn embed_ensure(core: State<'_, Arc<Core>>) -> AppResult<EmbedStatus> {
    core.embed_ensure()
}

#[tauri::command]
pub fn embed_texts(core: State<'_, Arc<Core>>) -> AppResult<()> {
    core.embed_texts()
}
