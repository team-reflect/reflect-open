//! X's syndication API command, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use serde_json::Value;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn x_syndication_fetch(
    core: State<'_, Arc<Core>>,
    post_id: String,
) -> AppResult<Option<Value>> {
    core.x_syndication_fetch(post_id).await
}
