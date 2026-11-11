//! OS keychain commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub async fn secret_set(core: State<'_, Arc<Core>>, name: String, value: String) -> AppResult<()> {
    core.secret_set(name, value).await
}

#[tauri::command]
pub async fn secret_get(core: State<'_, Arc<Core>>, name: String) -> AppResult<Option<String>> {
    core.secret_get(name).await
}

#[tauri::command]
pub async fn secret_delete(core: State<'_, Arc<Core>>, name: String) -> AppResult<()> {
    core.secret_delete(name).await
}
