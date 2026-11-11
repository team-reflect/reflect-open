//! iOS background assertion commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use tauri::State;

#[tauri::command]
pub fn background_task_begin(core: State<'_, Arc<Core>>) -> Option<String> {
    core.background_task_begin()
}

#[tauri::command]
pub fn background_task_end(token: String, core: State<'_, Arc<Core>>) {
    core.background_task_end(token);
}
