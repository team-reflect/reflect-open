//! User settings commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::settings::SettingsDoc;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub fn settings_load(core: State<'_, Arc<Core>>) -> AppResult<SettingsDoc> {
    core.settings_load()
}

#[tauri::command]
pub fn settings_save(core: State<'_, Arc<Core>>, settings: SettingsDoc) -> AppResult<()> {
    core.settings_save(settings)
}
