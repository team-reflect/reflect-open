//! The Reflect desktop shell: native primitives only.
//!
//! Per the architecture conventions, Rust owns *capabilities* (file IO, SQLite,
//! watching, recents) and TypeScript (`@reflect/core`) owns *policy and
//! composition* — a command here never encodes product rules beyond the
//! primitive it exposes. Each module wires one capability:
//! [`fs`] (graph file IO), [`db`] (SQLite index), [`watcher`] (file events),
//! [`recents`] (recent-graphs store), [`settings`] (user settings store),
//! [`secrets`] (OS keychain), [`git`] (backup/sync primitives),
//! [`capture`] (link-capture inbox + native-messaging host plumbing),
//! [`calendar`] (read-only Apple Calendar access),
//! [`contacts`] (live Apple Contacts lookups),
//! [`error`] (the shared error contract).

mod calendar;
mod capture;
mod contacts;
mod db;
mod devtools;
mod error;
mod fs;
mod git;
mod graph_gitignore;
mod quit;
mod recents;
mod secrets;
mod settings;

// The watcher and the embedding runtime are desktop capabilities (Plan 19):
// mobile swaps in stand-ins with the identical command surface, so the
// `invoke_handler` list below needs no platform branches.
#[cfg(desktop)]
mod embed;
#[cfg(mobile)]
#[path = "embed_mobile.rs"]
mod embed;
#[cfg(desktop)]
mod watcher;
#[cfg(mobile)]
#[path = "watcher_mobile.rs"]
mod watcher;

// TEMPORARY (Plan 19 spike A): on-device capability probes; delete with the
// spike once the runtime gate verdict is recorded in the plan.
#[cfg(mobile)]
mod spike_mobile;

use tauri::{Emitter, Manager};

/// Returns the desktop application version from Cargo metadata.
///
/// The canonical round-trip example for the IPC boundary: the frontend reaches
/// it only through `@reflect/core`'s typed, zod-validated `getAppVersion`.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Which UI family this build serves. The frontend's root gate (Plan 19)
/// switches between the desktop and mobile surface trees on this answer.
#[tauri::command]
fn app_platform() -> &'static str {
    if cfg!(target_os = "ios") {
        "ios"
    } else if cfg!(target_os = "android") {
        "android"
    } else {
        "desktop"
    }
}

/// The fixed mobile graph root (Plan 19): the app's `Documents/` directory,
/// exposed in the iOS Files app. Derived fresh on every call — iOS container
/// paths embed a UUID that changes across restore/update, so the frontend
/// must never persist the absolute path it gets back.
#[tauri::command]
fn mobile_graph_root(app: tauri::AppHandle) -> Result<String, error::AppError> {
    #[cfg(mobile)]
    {
        let dir = app
            .path()
            .document_dir()
            .map_err(|err| error::AppError::io(format!("no documents directory: {err}")))?;
        Ok(dir.to_string_lossy().into_owned())
    }
    #[cfg(desktop)]
    {
        let _ = app; // desktop picks graph folders; there is no fixed root
        Err(error::AppError::Unknown {
            message: "mobile_graph_root is mobile-only".into(),
        })
    }
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
    let builder = tauri::Builder::default();

    // Single-instance must be the first plugin so a second launch is caught
    // before any other state spins up: its `deep-link` feature hands the
    // launching instance's `reflect://` URL to the deep-link plugin, and the
    // callback re-focuses the running window. macOS delivers scheme opens to
    // the running app natively; this is the Windows/Linux equivalent.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init());

    // Deep links (`reflect://`) are desktop-only for now: the scheme is
    // registered at bundle time (`plugins.deep-link` in tauri.conf.json) and
    // the frontend consumes URLs through `onOpenUrl`.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    // Where the bundle doesn't register the scheme, do it at runtime: Linux
    // desktop entries, and Windows dev builds (the installer writes the
    // registry keys in production; macOS reads CFBundleURLTypes). Best-effort
    // — a headless Linux box without xdg-mime must not fail the launch.
    #[cfg(any(target_os = "linux", all(windows, debug_assertions)))]
    let builder = builder.setup(|app| {
        use tauri_plugin_deep_link::DeepLinkExt;
        if let Err(err) = app.deep_link().register_all() {
            tracing::warn!(error = %err, "deep-link scheme registration failed");
        }
        Ok(())
    });

    // Auto-update is desktop-only: updates verify against the minisign pubkey
    // in tauri.conf.json (`plugins.updater`), and `process` provides the
    // post-install relaunch. Mobile updates go through the app stores.
    // Window-state restore is likewise meaningless on mobile (one fullscreen
    // webview, no window frames to remember). The main window starts hidden
    // (`visible: false` in tauri.conf.json) so this plugin can restore its
    // geometry before first paint — avoiding a visible jump — and then reveal
    // it; mobile shows the window itself in the setup hook below.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // The keyboard bridge (Plan 19, decision 8) is mobile-only: desktop has
    // no software keyboard to track. (Sharing uses the webview's Web Share
    // API, so it needs no native plugin.)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_keyboard::init());

    // The main window starts hidden (`visible: false`); on desktop the
    // window-state plugin reveals it after restoring geometry, but mobile has
    // no such plugin, so show it here or the UI would never appear.
    //
    // (Also runs the TEMPORARY Plan 19 spike-A capability probe — delete that
    // line with the spike, but keep the window show.)
    #[cfg(mobile)]
    let builder = builder.setup(|app| {
        if let Some(window) = app.get_webview_window("main") {
            window.show()?;
        }
        spike_mobile::run_self_check(app.handle());
        Ok(())
    });

    builder
        .manage(fs::GraphState::default())
        .manage(fs::assets::AssetUploads::default())
        .manage(db::IndexState::default())
        .manage(watcher::WatcherState::default())
        .manage(quit::QuitState::default())
        .manage(embed::EmbedState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            app_platform,
            mobile_graph_root,
            fs::graph_open,
            fs::graph_create,
            fs::note_read,
            fs::note_write,
            fs::asset_write,
            fs::asset_read,
            fs::asset_open,
            fs::assets::asset_upload_begin,
            fs::assets::asset_upload_append,
            fs::assets::asset_upload_commit,
            fs::assets::asset_upload_abort,
            fs::assets::asset_import,
            fs::dir_list,
            fs::note_exists,
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
            db::index_move,
            db::note_move_indexed,
            db::index_meta_set,
            db::db_query,
            db::chat_message_save,
            db::chat_conversation_delete,
            db::embed_apply,
            db::embed_remove,
            embed::embed_status,
            embed::embed_ensure,
            embed::embed_texts,
            watcher::watch_start,
            watcher::watch_stop,
            calendar::calendar_authorization_status,
            calendar::calendar_request_access,
            calendar::calendar_list_calendars,
            calendar::calendar_list_events,
            contacts::contacts_authorization_status,
            contacts::contacts_request_access,
            contacts::contacts_lookup_by_email,
            contacts::contacts_lookup_by_name,
            capture::capture_host_register,
            capture::capture_inbox_list,
            capture::capture_inbox_spool,
            capture::capture_inbox_read,
            capture::capture_inbox_remove,
            capture::capture_inbox_reject,
            capture::capture_screenshot_promote,
            capture::capture_meta_fetch,
            git::git_status,
            git::git_setup,
            git::git_disconnect,
            git::git_clone,
            git::git_commit_all,
            git::git_fetch,
            git::git_merge_remote,
            git::git_push,
            quit::quit_confirm,
            devtools::toggle_devtools,
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
