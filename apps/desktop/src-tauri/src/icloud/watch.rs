//! iCloud change watcher commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn icloud_watch_start(root: String, core: State<'_, Arc<Core>>) -> AppResult<()> {
    core.icloud_watch_start(root).await
}

#[tauri::command]
pub fn icloud_watch_stop(core: State<Arc<Core>>) -> AppResult<()> {
    core.icloud_watch_stop()
}
