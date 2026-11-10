//! iCloud Drive storage commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::icloud::storage::{IcloudStatus, MobileStorage};
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn mobile_storage(core: State<'_, Arc<Core>>) -> AppResult<MobileStorage> {
    core.mobile_storage().await
}

#[tauri::command]
pub async fn icloud_download_pending(
    root: String,
    notes_only: bool,
    core: State<'_, Arc<Core>>,
) -> AppResult<u32> {
    core.icloud_download_pending(root, notes_only).await
}

#[tauri::command]
pub fn mobile_storage_local(core: State<Arc<Core>>) -> AppResult<String> {
    core.mobile_storage_local()
}

#[tauri::command]
pub async fn icloud_pending_count(
    root: String,
    notes_only: bool,
    core: State<'_, Arc<Core>>,
) -> AppResult<u32> {
    core.icloud_pending_count(root, notes_only).await
}

#[tauri::command]
pub async fn icloud_request_downloads(
    paths: Vec<String>,
    core: State<'_, Arc<Core>>,
) -> AppResult<u32> {
    core.icloud_request_downloads(paths).await
}

#[tauri::command]
pub async fn icloud_status(core: State<'_, Arc<Core>>) -> AppResult<IcloudStatus> {
    core.icloud_status().await
}

#[tauri::command]
pub async fn icloud_adopt_graph(generation: u64, core: State<'_, Arc<Core>>) -> AppResult<String> {
    core.icloud_adopt_graph(generation).await
}
