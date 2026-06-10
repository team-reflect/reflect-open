//! The Reflect desktop shell: native primitives only.
//!
//! Per the architecture conventions, Rust owns *capabilities* (file IO, SQLite,
//! watching, recents) and TypeScript (`@reflect/core`) owns *policy and
//! composition* — a command here never encodes product rules beyond the
//! primitive it exposes. Each module wires one capability:
//! [`fs`] (graph file IO), [`db`] (SQLite index), [`watcher`] (file events),
//! [`recents`] (recent-graphs store), [`settings`] (user settings store),
//! [`secrets`] (OS keychain), [`error`] (the shared error contract).

mod db;
mod embed;
mod error;
mod fs;
mod quit;
mod recents;
mod secrets;
mod settings;
mod watcher;

use tauri::{Emitter, Manager};

/// Returns the desktop application version from Cargo metadata.
///
/// The canonical round-trip example for the IPC boundary: the frontend reaches
/// it only through `@reflect/core`'s typed, zod-validated `getAppVersion`.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Route `tracing` output to stderr, honoring `RUST_LOG` (default `info`).
fn init_tracing() {
    use tracing_subscriber::EnvFilter;
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    // `try_init` so a second call (tests, mobile re-entry) is a no-op, not a panic.
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_tracing();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .manage(fs::GraphState::default())
        .manage(db::IndexState::default())
        .manage(watcher::WatcherState::default())
        .manage(quit::QuitState::default())
        .manage(embed::EmbedState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            fs::graph_open,
            fs::graph_create,
            fs::note_read,
            fs::note_write,
            fs::asset_write,
            fs::note_move,
            fs::note_delete,
            fs::list_files,
            recents::recent_graphs,
            recents::forget_recent,
            settings::settings_load,
            settings::settings_save,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            db::index_open,
            db::index_apply,
            db::index_apply_batch,
            db::index_remove,
            db::index_clear,
            db::db_query,
            db::embed_apply,
            db::embed_remove,
            embed::embed_status,
            embed::embed_ensure,
            embed::embed_texts,
            watcher::watch_start,
            watcher::watch_stop,
            quit::quit_confirm,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = &event {
                // A user/OS-initiated quit (⌘Q — no exit code) with a live
                // webview defers once so the frontend can flush dirty note
                // buffers (`app:quit-requested` → `quit_confirm`). An exit
                // carrying a code is the confirm itself; with no webview left
                // the window-close path has already flushed.
                let quit = app.state::<quit::QuitState>();
                if code.is_none() && !quit.flushed() && !app.webview_windows().is_empty() {
                    api.prevent_exit();
                    let _ = app.emit("app:quit-requested", ());
                }
            }
        });
}
