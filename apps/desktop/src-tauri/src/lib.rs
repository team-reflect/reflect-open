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
//! [`skill`] (per-graph agent-skill install under `~/.agents/skills/`),
//! [`calendar`] (read-only Apple Calendar access),
//! [`contacts`] (live Apple Contacts lookups),
//! [`error`] (the shared error contract).

mod background_task;
mod calendar;
mod capture;
mod conflict;
mod contacts;
mod db;
mod devtools;
mod error;
mod fs;
mod git;
mod graph_gitignore;
mod icloud;
mod quit;
mod recents;
mod secrets;
mod settings;
mod skill;
mod windows;

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

/// Returns the application version from Tauri's resolved package metadata.
///
/// The canonical round-trip example for the IPC boundary: the frontend reaches
/// it only through `@reflect/core`'s typed, zod-validated `getAppVersion`.
#[tauri::command]
fn app_version<R: tauri::Runtime>(app: tauri::AppHandle<R>) -> String {
    app.package_info().version.to_string()
}

/// Builds the HTTP User-Agent from the same resolved version shown in the UI.
pub(crate) fn app_user_agent<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    format!("Reflect/{}", app.package_info().version)
}

#[cfg(test)]
mod app_metadata_tests {
    use super::{app_user_agent, app_version};

    #[test]
    fn app_metadata_uses_tauri_package_info() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = "7.8.9-beta.4".parse().expect("valid version");
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("mock app");

        assert_eq!(app_version(app.handle().clone()), "7.8.9-beta.4");
        assert_eq!(app_user_agent(app.handle()), "Reflect/7.8.9-beta.4");
    }
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
        windows::surface_main_window(app);
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
    // geometry before first paint — avoiding a visible jump. Visibility is
    // deliberately not persistent: shutdown and updater relaunches can observe
    // a transiently hidden window, which must not suppress every later launch.
    // The Ready event reveals the restored window below.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            // Note windows are excluded from state tracking: they cascade
            // fresh from their opener, and their content-hashed labels would
            // otherwise accrete in the state file forever.
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(windows::restorable_window_state_flags())
                .with_filter(|label| !label.starts_with(windows::NOTE_WINDOW_PREFIX))
                .build(),
        );

    // The keyboard bridge (Plan 19, decision 8) is mobile-only: desktop has
    // no software keyboard to track. (Sharing uses the webview's Web Share
    // API, so it needs no native plugin; haptics ride this plugin's
    // `impact_light` command.)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_keyboard::init());

    // The native audio-memo recorder is mobile-only too: desktop records
    // through the webview's MediaRecorder (`use-audio-recorder.ts`), while
    // mobile capture must survive the webview (interruptions, backgrounding),
    // so it runs on AVAudioRecorder behind this plugin.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_recording::init());

    // The main window starts hidden (`visible: false`); desktop reveals it on
    // Ready after restoring geometry, but mobile has no window-state plugin,
    // so show it here or the UI would never appear.
    //
    // (Also runs the TEMPORARY Plan 19 spike-A capability probe — delete that
    // line with the spike, but keep the window show.)
    #[cfg(mobile)]
    let builder = builder.setup(|app| {
        if let Some(window) = app.get_webview_window(windows::MAIN_WINDOW_LABEL) {
            window.show()?;
        }
        spike_mobile::run_self_check(app.handle());
        Ok(())
    });

    builder
        // Serves note images (`assets/…`) to the webview. Registered as an
        // *asynchronous* protocol on purpose: WebKit delivers custom-scheme
        // requests on the main thread, and a synchronous handler (like the
        // built-in `asset:` protocol this replaces) freezes the whole app for
        // the duration of every uncached read — seconds on iOS, where a first
        // read can wait on an iCloud download.
        .register_asynchronous_uri_scheme_protocol(
            fs::asset_protocol::SCHEME,
            fs::asset_protocol::handle,
        )
        .manage(fs::GraphState::default())
        .manage(background_task::BackgroundTaskState::default())
        .manage(fs::ImportCancel::default())
        .manage(fs::assets::AssetUploads::default())
        .manage(db::IndexState::default())
        .manage(watcher::WatcherState::default())
        .manage(quit::QuitState::default())
        .manage(windows::WindowInit::default())
        .manage(embed::EmbedState::default())
        .invoke_handler(tauri::generate_handler![
            app_version,
            app_platform,
            background_task::background_task_begin,
            background_task::background_task_end,
            icloud::storage::mobile_storage,
            icloud::storage::mobile_storage_local,
            icloud::storage::icloud_download_pending,
            icloud::storage::icloud_pending_count,
            icloud::storage::icloud_status,
            icloud::storage::icloud_adopt_graph,
            icloud::sweep::icloud_conflicts_scan,
            icloud::watch::icloud_watch_start,
            icloud::watch::icloud_watch_stop,
            fs::graph_open,
            fs::graph_create,
            fs::graph_delete,
            fs::graph_import_reflect_v1_zip,
            fs::graph_import_cancel,
            fs::note_read,
            fs::note_create,
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
            skill::skill_status,
            skill::skill_install,
            skill::skill_uninstall,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            db::index_open,
            db::index_apply,
            db::index_apply_batch,
            db::index_remove,
            db::index_clear,
            db::index_move,
            db::index_reconcile_scan,
            db::index_touch,
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
            capture::capture_shared_inbox_relay,
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
            windows::open_note_window,
            windows::window_bootstrap,
            windows::close_note_windows,
            devtools::toggle_devtools,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match &event {
            // Config windows are built before Ready, including the synchronous
            // window-state restore. Reveal the main window only after that
            // geometry is settled, regardless of any stale persisted
            // visibility from an older build.
            #[cfg(desktop)]
            tauri::RunEvent::Ready => {
                windows::surface_main_window(app);
            }
            // Clicking the Dock icon is macOS's recovery path when an app has
            // no visible windows. Surface a hidden/minimized main window, or
            // recreate it if the user previously closed it with ⌘W.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } => {
                if !*has_visible_windows
                    || app
                        .get_webview_window(windows::MAIN_WINDOW_LABEL)
                        .is_none()
                {
                    windows::reopen_main_window(app);
                }
            }
            // The lock-screen widget opens `reflect://record-audio`; hand it
            // to the recording plugin's persisted action queue (the V1
            // handshake) so the request survives webview churn and cold
            // starts. Desktop scheme opens flow through
            // tauri-plugin-deep-link to the frontend instead.
            #[cfg(any(target_os = "macos", target_os = "ios"))]
            tauri::RunEvent::Opened { urls } => {
                #[cfg(mobile)]
                for url in urls {
                    if url.scheme() == "reflect" && url.host_str() == Some("record-audio") {
                        // This callback runs on the main thread, and
                        // `run_mobile_plugin` blocks its caller until the
                        // Swift command resolves — which `queueAction` does
                        // from the main queue. Calling it inline deadlocks
                        // the main thread (the watchdog then kills the app),
                        // so queue from a worker thread instead.
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            use tauri_plugin_recording::RecordingExt;
                            if let Err(err) = app.recording().queue_action("recordAudio") {
                                tracing::warn!(error = %err, "queueing the record-audio action failed");
                            }
                        });
                    }
                }
                #[cfg(not(mobile))]
                let _ = urls;
            }
            tauri::RunEvent::ExitRequested { code, api, .. } => {
                // A user/OS-initiated quit (⌘Q — no exit code) with live
                // webviews defers so the frontend can flush dirty note
                // buffers (`app:quit-requested` → `quit_confirm`). The
                // handshake is armed with the webview count: every window
                // flushes its own buffers, and only the last confirmation
                // exits (quit.rs). An exit carrying a code is that final
                // confirm itself; with no webview left the window-close path
                // has already flushed.
                let quit = app.state::<quit::QuitState>();
                let windows: Vec<String> = app.webview_windows().keys().cloned().collect();
                if code.is_none() && !windows.is_empty() {
                    api.prevent_exit();
                    quit.arm(windows);
                    let _ = app.emit("app:quit-requested", ());
                }
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::Destroyed,
                ..
            } => {
                // A window destroyed mid-handshake (user closed it while the
                // quit flush ran) can no longer confirm — settle its label or
                // the surviving windows' quit would hang forever.
                let quit = app.state::<quit::QuitState>();
                if quit.settle(label) {
                    app.exit(0);
                }
                // Note windows adopt the main window's graph session and
                // degrade silently without it (no indexing, sync, or rename
                // propagation) — they close with their owner. `close()`, not
                // `destroy()`: each child's close-requested flush still runs,
                // exactly like ⌘W (docs/multi-window.md).
                if label == windows::MAIN_WINDOW_LABEL {
                    for (child_label, child) in app.webview_windows() {
                        if child_label.starts_with(windows::NOTE_WINDOW_PREFIX) {
                            let _ = child.close();
                        }
                    }
                }
            }
            _ => {}
        });
}
