//! Recent-graphs commands, forwarded to [`reflect_core::Core`].

use std::sync::Arc;

use reflect_core::Core;
use reflect_core::recents::RecentGraph;
use tauri::State;

use crate::error::AppResult;

#[tauri::command]
pub fn recent_graphs(core: State<'_, Arc<Core>>) -> AppResult<Vec<RecentGraph>> {
    core.recent_graphs()
}

#[tauri::command]
pub fn forget_recent(core: State<'_, Arc<Core>>, root: String) -> AppResult<()> {
    core.forget_recent(root)
}
