mod db;
mod error;
mod fs;
mod recents;
mod watcher;

/// Returns the desktop application version from Cargo metadata.
///
/// The canonical round-trip example for the IPC boundary: the frontend reaches
/// it only through `@reflect/core`'s typed, zod-validated `getAppVersion`.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(fs::GraphState::default())
        .manage(db::IndexState::default())
        .manage(watcher::WatcherState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            fs::graph_open,
            fs::graph_create,
            fs::note_read,
            fs::note_write,
            fs::note_move,
            fs::note_delete,
            fs::list_files,
            recents::recent_graphs,
            recents::forget_recent,
            db::index_open,
            db::index_apply,
            db::index_remove,
            db::index_clear,
            db::db_query,
            watcher::watch_start,
            watcher::watch_stop,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
