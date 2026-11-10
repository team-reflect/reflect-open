//! X post archive commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use serde_json::Value;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn x_archive_write(
    core: State<'_, Arc<Core>>,
    generation: u64,
    value: Value,
) -> AppResult<()> {
    core.x_archive_write(generation, value).await
}

#[tauri::command]
pub async fn x_archive_resolve(
    core: State<'_, Arc<Core>>,
    generation: u64,
    post_id: String,
) -> AppResult<Option<Value>> {
    core.x_archive_resolve(generation, post_id).await
}

#[tauri::command]
pub async fn x_archive_owners(
    core: State<'_, Arc<Core>>,
    asset_path: String,
    generation: Option<u64>,
) -> AppResult<Vec<String>> {
    core.x_archive_owners(asset_path, generation).await
}
