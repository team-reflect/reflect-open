//! Web-inspector access — debuggable in every build, not just `cargo dev`.
//!
//! Tauri compiles the inspector in automatically for debug builds but strips it
//! from release builds unless the `tauri` crate's `devtools` feature is on (set
//! in `Cargo.toml`). With it on, the methods below exist in release too, so a
//! shipped app can always be opened up and debugged.
//!
//! The frontend binds ⌘⇧I to {@link toggle_devtools} (`@reflect/core`'s
//! `toggleDevtools`); on macOS the webview's native ⌘⌥I and right-click
//! "Inspect Element" work as well once the feature is compiled in.

use tauri::WebviewWindow;

/// Open the calling window's web inspector, or close it if it is already open.
///
/// A no-op-shaped command: it returns unit (serialized as `null`) so the typed
/// binding can validate the response like any other IPC call.
#[tauri::command]
pub fn toggle_devtools(window: WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}
