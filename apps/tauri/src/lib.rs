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
    use urlpattern::{UrlPattern, UrlPatternInit, UrlPatternMatchInput};

    fn default_permissions() -> Vec<serde_json::Value> {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/default.json"))
                .expect("valid default capability");
        capability["permissions"]
            .as_array()
            .expect("capability permissions")
            .clone()
    }

    #[test]
    fn desktop_capability_allows_main_window_hide() {
        assert!(
            default_permissions()
                .iter()
                .any(|permission| permission.as_str() == Some("core:window:allow-hide"))
        );
    }

    // Copied from tauri-plugin-http, which keeps its scope type private:
    // https://github.com/tauri-apps/plugins-workspace/blob/http-v2.8.3/plugins/http/src/scope.rs#L17-L34
    fn parse_url_pattern(s: &str) -> UrlPattern {
        let mut init = UrlPatternInit::parse_constructor_string::<regex::Regex>(s, None)
            .expect("valid URL pattern");
        if init.search.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
            init.search.replace("*".to_string());
        }
        if init.hash.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
            init.hash.replace("*".to_string());
        }
        if init
            .pathname
            .as_ref()
            .map(|p| p.is_empty() || p == "/")
            .unwrap_or(true)
        {
            init.pathname.replace("*".to_string());
        }
        UrlPattern::parse(init, Default::default()).expect("valid URL pattern")
    }

    /// Whether the `http:default` scope allows `url`. A pattern that omits
    /// the port matches only the scheme's default port, so the wildcard
    /// entries must stay spelled `https://*:*` / `http://*:*`.
    fn http_allows(url: &str) -> bool {
        let url = tauri::Url::parse(url).expect("valid URL");
        default_permissions()
            .iter()
            .filter(|permission| permission["identifier"] == "http:default")
            .flat_map(|permission| permission["allow"].as_array().cloned().unwrap_or_default())
            .any(|entry| {
                parse_url_pattern(entry["url"].as_str().expect("scope url"))
                    .test(UrlPatternMatchInput::Url(url.clone()))
                    .unwrap_or_default()
            })
    }

    #[test]
    fn http_scope_reaches_endpoints_on_custom_ports_and_hosts() {
        for url in [
            "http://localhost:1234/v1/chat/completions",
            "http://127.0.0.1:11434/v1/models",
            "http://192.168.1.10:8000/v1/models",
            "https://llm.example.com/v1/chat/completions",
            "https://llm.example.com:8443/v1/chat/completions",
            "https://api.openai.com/v1/responses",
            "https://api.anthropic.com/v1/messages",
            "https://generativelanguage.googleapis.com/v1beta/models",
            "https://openrouter.ai/api/v1/chat/completions",
            "https://github.com/login/device/code",
            "https://api.github.com/user",
        ] {
            assert!(http_allows(url), "{url}");
        }
    }

    #[test]
    fn http_scope_does_not_open_non_http_schemes() {
        for url in [
            "file:///etc/passwd",
            "ftp://example.com/file",
            "ws://localhost:1234/socket",
        ] {
            assert!(!http_allows(url), "{url}");
        }
    }
}

/// Builds the desktop command handler from the `desktop` rows of the command
/// table in `reflect_types::commands`.
macro_rules! desktop_handler {
    (
        core { $( $core:tt )* }
        desktop { $( $module:ident :: $method:ident ( $( $arg:ident : $ty:ty ),* ) -> $ret:ty ),* $(,)? }
        shell { $( $shell:tt )* }
    ) => {
        tauri::generate_handler![
            $( $module::$method, )*
        ]
    };
}

pub fn run() {
    let builder = tauri::Builder::default();

    // Single-instance must be the first plugin so a second launch is caught
    // before any other state spins up: its `deep-link` feature hands the
    // launching instance's `reflect://` URL to the deep-link plugin, and the
    // callback re-focuses the running window. macOS delivers scheme opens to
    // the running app natively; this is the Windows/Linux equivalent.
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        windows::surface_main_window(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init());

    // Deep links (`reflect://`): the scheme is registered at bundle time
    // (`plugins.deep-link` in tauri.conf.json) and the frontend consumes URLs
    // through `onOpenUrl`.
    let builder = builder.plugin(tauri_plugin_deep_link::init());

    // Where the bundle doesn't register the scheme, do it at runtime: Linux
    // desktop entries, and Windows dev builds (the installer writes the
    // registry keys in production; macOS reads CFBundleURLTypes). Best-effort
    // — a headless Linux box without xdg-mime must not fail the launch.
    //
    // The main window is `create: false` in the config and built here, so it
    // can carry a new-window handler. It starts hidden (`visible: false`); the
    // page-load hook below reveals it after restoring geometry.
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
        windows::build_main_window(app.handle())?;
        Ok(())
    });

    // Auto-update verifies against the minisign pubkey in tauri.conf.json
    // (`plugins.updater`), and `process` provides the post-install relaunch.
    // The main window starts hidden (`visible: false` in tauri.conf.json) so
    // the window-state plugin can restore its geometry before first paint,
    // which avoids a visible jump. Visibility is
    // deliberately not persistent: shutdown and updater relaunches can observe
    // a transiently hidden window, which must not suppress every later launch.
    // The page-load hook below reveals it once the webview paints its first
    // frame, so `theme-init.js` has applied the OS-preferred `.dark` scope
    // before the window becomes visible — otherwise WKWebView flashes its
    // default white backing between show() and the first HTML paint.
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
    let revealed_main = std::sync::Arc::new(std::sync::Once::new());

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

    builder
        // Serves note images (`assets/…`) to the webview. Registered as an
        // *asynchronous* protocol on purpose: WebKit delivers custom-scheme
        // requests on the main thread, and a synchronous handler (like the
        // built-in `asset:` protocol this replaces) freezes the whole app for
        // the duration of every uncached read, which can wait on an iCloud
        // download.
        .register_asynchronous_uri_scheme_protocol(
            fs::asset_protocol::SCHEME,
            fs::asset_protocol::handle,
        )
        .manage(quit::QuitState::default())
        .manage(windows::WindowInit::default())
        .invoke_handler({
            let desktop_commands: fn(tauri::ipc::Invoke) -> bool =
                reflect_types::commands!(desktop_handler);
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
                    || app.get_webview_window(windows::MAIN_WINDOW_LABEL).is_none()
                {
                    windows::reopen_main_window(app);
                }
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
