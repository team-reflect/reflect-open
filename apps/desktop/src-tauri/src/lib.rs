//! The Reflect desktop shell: native primitives only.
//!
//! Per the architecture conventions, Rust owns *capabilities* (file IO, SQLite,
//! watching, recents) and TypeScript (`@reflect/core`) owns *policy and
//! composition* — a command here never encodes product rules beyond the
//! primitive it exposes. The commands shared with the Swift iOS shell live in
//! `reflect-core`; [`core_commands`] answers their invokes through
//! `Core::dispatch`. The modules here wire the desktop-only capabilities:
//! [`windows`] (note windows), [`menu`] (the macOS app menu, incl. Paste and
//! Match Style), [`skill`] (per-graph agent-skill install under
//! `~/.agents/skills/`), [`calendar`] (read-only Apple Calendar access),
//! [`fs`] (the asset protocol), [`error`] (the shared error contract).

mod calendar;
mod capture;
mod core_commands;
mod db;
mod devtools;
mod error;
mod fs;
mod host;
mod logging;
mod menu;
mod quit;
mod skill;
#[cfg(target_os = "macos")]
mod wake;
mod windows;

use std::sync::Arc;

use reflect_core::{Core, CoreConfig};
use tauri::{Emitter, Manager};

/// Builds the HTTP User-Agent from the same resolved version shown in the UI.
pub(crate) fn app_user_agent<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> String {
    format!("Reflect/{}", app.package_info().version)
}

#[cfg(test)]
mod app_metadata_tests {
    use super::app_user_agent;

    #[test]
    fn app_metadata_uses_tauri_package_info() {
        let mut context = tauri::test::mock_context(tauri::test::noop_assets());
        context.package_info_mut().version = "7.8.9-beta.4".parse().expect("valid version");
        let app = tauri::test::mock_builder()
            .build(context)
            .expect("mock app");

        assert_eq!(app_user_agent(app.handle()), "Reflect/7.8.9-beta.4");
    }
}

#[cfg(test)]
mod capability_tests {
    #[test]
    fn desktop_capability_allows_main_window_hide() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("valid default capability");
        let permissions = capability["permissions"]
            .as_array()
            .expect("capability permissions");

        assert!(
            permissions
                .iter()
                .any(|permission| permission.as_str() == Some("core:window:allow-hide"))
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
    //
    // The main window is `create: false` in the config and built here, so it
    // can carry a new-window handler. It starts hidden (`visible: false`);
    // desktop reveals it from the page-load hook below after restoring
    // geometry, but mobile has no window-state plugin, so show it here or the
    // UI would never appear.
    let builder = builder.setup(|app| {
        logging::init(app.handle());
        let host = Arc::new(host::TauriHost::new(app.handle().clone()));
        let config = CoreConfig {
            app_data_dir: app.path().app_data_dir().ok(),
            document_dir: app
                .path()
                .document_dir()
                .inspect_err(|err| tracing::warn!(%err, "no documents directory"))
                .ok(),
            user_agent: app_user_agent(app.handle()),
        };
        let core = Core::new(config, host).map_err(|err| err.message().to_string())?;
        app.manage(Arc::new(core));
        #[cfg(any(target_os = "linux", all(windows, debug_assertions)))]
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            if let Err(err) = app.deep_link().register_all() {
                tracing::warn!(error = %err, "deep-link scheme registration failed");
            }
        }
        #[cfg(desktop)]
        windows::build_main_window(app.handle())?;
        #[cfg(mobile)]
        windows::build_main_window(app.handle())?.show()?;
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
    // The page-load hook below reveals it once the webview paints its first
    // frame, so `theme-init.js` has applied the OS-preferred `.dark` scope
    // before the window becomes visible — otherwise WKWebView flashes its
    // default white backing between show() and the first HTML paint.
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

    // Reveal the main window on `PageLoadEvent::Finished`, not on
    // `RunEvent::Ready`. Ready only guarantees plugin init + window-state
    // geometry restore have finished — it does not wait for the webview to
    // load the frontend, so on warm launches WKWebView is still on its
    // default white backing when show() runs, producing the intermittent
    // startup flash. Note windows already gate on Finished the same way
    // (see `open_note_window` in windows.rs). `Once` fires exactly on the
    // first Finished so reloads (⌘R, dev HMR, webview crash recovery)
    // never re-steal focus. `on_page_load` also fires for note windows;
    // filter by label so this handler only reveals the main one. Ready still
    // matters as the point where the fallback reveal is armed, below.
    #[cfg(desktop)]
    let revealed_main = std::sync::Arc::new(std::sync::Once::new());

    #[cfg(desktop)]
    let builder = {
        let revealed = std::sync::Arc::clone(&revealed_main);
        builder.on_page_load(move |webview, payload| {
            if webview.label() != windows::MAIN_WINDOW_LABEL {
                return;
            }
            if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            revealed.call_once(|| {
                windows::surface_main_window(webview.app_handle());
            });
        })
    };

    // The keyboard bridge (Plan 19, decision 8) is mobile-only: desktop has
    // no software keyboard to track. (Sharing uses the webview's Web Share
    // API, so it needs no native plugin.)
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_keyboard::init());

    // Haptics are mobile-only too: WKWebView has no `navigator.vibrate`, so
    // taps reach `UIImpactFeedbackGenerator` through this plugin's
    // `impact_light` command.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_mobile_haptics::init());

    // The native audio-memo recorder is mobile-only too: desktop records
    // through the webview's MediaRecorder (`use-audio-recorder.ts`), while
    // mobile capture must survive the webview (interruptions, backgrounding),
    // so it runs on AVAudioRecorder behind this plugin.
    #[cfg(mobile)]
    let builder = builder.plugin(tauri_plugin_recording::init());

    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_iap::init());

    // TestFlight and the App Store install the same binary, so only a
    // runtime probe (StoreKit 2's `AppTransaction.environment`) can tell
    // the channels apart, e.g. for the paywall gate.
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_app_store::init());

    // OAuth-style sign-in in an in-app browser sheet (ASWebAuthenticationSession).
    #[cfg(target_os = "ios")]
    let builder = builder.plugin(tauri_plugin_web_auth::init());

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
        .manage(quit::QuitState::default())
        .manage(windows::WindowInit::default())
        .invoke_handler({
            let desktop_commands: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
            skill::skill_status,
            skill::skill_install,
            skill::skill_uninstall,
            menu::menu_install_paste_and_match_style,
            calendar::calendar_authorization_status,
            calendar::calendar_request_access,
            calendar::calendar_list_calendars,
            calendar::calendar_list_events,
            quit::quit_confirm,
            windows::open_note_window,
            windows::window_bootstrap,
            windows::close_note_windows,
            devtools::toggle_devtools,
        ];
            move |invoke| {
                if Core::has_command(invoke.message.command()) {
                    core_commands::handle(invoke);
                    true
                } else {
                    desktop_commands(invoke)
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |app, event| match &event {
            // Ready no longer reveals the main window — the page-load hook
            // above does, once the webview has painted. It is still the first
            // point where the window and an app handle both exist, so arm the
            // fallback that reveals it anyway if that load never finishes.
            // (Arming from `.setup()` would silently replace the deep-link
            // registration hook, which Tauri stores as a single callback.)
            #[cfg(desktop)]
            tauri::RunEvent::Ready => {
                // Wake-from-sleep is the one moment external iCloud writes
                // can land without the FSEvents watcher seeing them; the
                // observer asks the frontend for one full reconcile per wake
                // (wake.rs).
                #[cfg(target_os = "macos")]
                wake::install(app);
                let app = app.clone();
                windows::arm_reveal_fallback(
                    &revealed_main,
                    windows::MAIN_WINDOW_LABEL,
                    move || {
                        windows::surface_main_window(&app);
                    },
                );
            }
            // Clicking the Dock icon is macOS's recovery path when an app has
            // no visible windows. Surface the hidden/minimized main window,
            // or recreate it after an unexpected destruction.
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
