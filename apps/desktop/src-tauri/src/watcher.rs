//! File watcher commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub fn watch_start(core: State<'_, Arc<Core>>) -> AppResult<()> {
    core.watch_start()
}

#[tauri::command]
pub fn watch_stop(core: State<'_, Arc<Core>>) -> AppResult<()> {
    core.watch_stop()
}
