//! Link-capture commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
pub(crate) use reflect_core::capture::atomic_write_to;
use reflect_types::FileMeta;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub fn capture_host_register(core: State<Arc<Core>>) -> AppResult<()> {
    core.capture_host_register()
}

#[tauri::command]
pub fn capture_inbox_list(generation: u64, core: State<Arc<Core>>) -> AppResult<Vec<FileMeta>> {
    core.capture_inbox_list(generation)
}

#[tauri::command]
pub fn capture_inbox_spool(
    name: String,
    json: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.capture_inbox_spool(name, json, generation)
}

#[tauri::command]
pub fn capture_inbox_read(
    name: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<String> {
    core.capture_inbox_read(name, generation)
}

#[tauri::command]
pub fn capture_inbox_remove(
    name: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.capture_inbox_remove(name, generation)
}

#[tauri::command]
pub fn capture_inbox_reject(
    name: String,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.capture_inbox_reject(name, generation)
}

#[tauri::command]
pub async fn capture_shared_inbox_relay(
    generation: u64,
    core: State<'_, Arc<Core>>,
) -> AppResult<u32> {
    core.capture_shared_inbox_relay(generation).await
}

#[tauri::command]
pub async fn capture_quick_note_defaults_write(
    parent: String,
    core: State<'_, Arc<Core>>,
) -> AppResult<()> {
    core.capture_quick_note_defaults_write(parent).await
}

#[tauri::command]
pub fn capture_screenshot_promote(
    spool_name: String,
    asset_path: String,
    max_dim: u32,
    generation: u64,
    core: State<Arc<Core>>,
) -> AppResult<()> {
    core.capture_screenshot_promote(spool_name, asset_path, max_dim, generation)
}

#[tauri::command]
pub async fn capture_link_preview(
    url: String,
    core: State<'_, Arc<Core>>,
) -> AppResult<Option<String>> {
    core.capture_link_preview(url).await
}

#[tauri::command]
pub async fn capture_meta_fetch(url: String, core: State<'_, Arc<Core>>) -> AppResult<String> {
    core.capture_meta_fetch(url).await
}

#[tauri::command]
pub async fn capture_oembed_fetch(url: String, core: State<'_, Arc<Core>>) -> AppResult<String> {
    core.capture_oembed_fetch(url).await
}
