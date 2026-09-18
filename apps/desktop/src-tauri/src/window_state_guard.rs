//! Boot-time recovery for the window-state file: drop any persisted window
//! geometry too small to be a real window, so the window-state plugin
//! restores its defaults instead of replaying a corrupt size.
//!
//! macOS has been observed reporting a collapsed frame (a 2x2-physical-pixel
//! main window) around an updater relaunch, and the plugin persists whatever
//! it reads at exit with no plausibility floor. Restoring such a size yields
//! a window that is technically visible but impossible to see, and every
//! healthy session then re-persists the same corrupt geometry at exit, so
//! the app looks like it no longer opens until the file is deleted by hand.

use tauri::plugin::{Builder as PluginBuilder, TauriPlugin};
use tauri::{Manager, Runtime};

/// Persisted sizes are physical pixels. Anything under this on either axis
/// cannot be a window a user produced (the config minimum is 200x200
/// logical), while the corrupt sizes observed in the wild (2x2 here, 16x59
/// in https://github.com/tauri-apps/plugins-workspace/issues/251) fall well
/// below it.
const MIN_PLAUSIBLE_SIZE: u64 = 100;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    PluginBuilder::new("window-state-guard")
        .setup(|app, _api| {
            let Ok(dir) = app.path().app_config_dir() else {
                return Ok(());
            };
            let path = dir.join(tauri_plugin_window_state::DEFAULT_FILENAME);
            let Ok(contents) = std::fs::read_to_string(&path) else {
                return Ok(());
            };
            if let Some(sanitized) = drop_degenerate_entries(&contents) {
                tracing::warn!(path = %path.display(), "dropping degenerate window state");
                if let Err(err) = std::fs::write(&path, sanitized) {
                    tracing::warn!(error = %err, "failed to rewrite the window-state file");
                }
            }
            Ok(())
        })
        .build()
}

/// The file's content with every entry whose persisted size is implausibly
/// small removed, or `None` when nothing needs to change. Content that does
/// not parse is also `None`: the window-state plugin treats an unreadable
/// file as no state at all, which is already the safe outcome.
fn drop_degenerate_entries(contents: &str) -> Option<Vec<u8>> {
    let mut states: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(contents).ok()?;
    let before = states.len();
    states.retain(|_, state| !is_degenerate(state));
    if states.len() == before {
        return None;
    }
    serde_json::to_vec_pretty(&states).ok()
}

fn is_degenerate(state: &serde_json::Value) -> bool {
    let axis = |key: &str| state.get(key).and_then(serde_json::Value::as_u64);
    match (axis("width"), axis("height")) {
        (Some(width), Some(height)) => width < MIN_PLAUSIBLE_SIZE || height < MIN_PLAUSIBLE_SIZE,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The exact state from the field report: a 2x2 main window.
    const POISONED: &str = r#"{"main":{"width":2,"height":2,"x":0,"y":60,"prev_x":0,"prev_y":60,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;

    fn parse(bytes: &[u8]) -> serde_json::Map<String, serde_json::Value> {
        serde_json::from_slice(bytes).expect("valid JSON")
    }

    #[test]
    fn drops_the_reported_two_pixel_window() {
        let sanitized = drop_degenerate_entries(POISONED).expect("a rewrite");
        assert!(parse(&sanitized).is_empty());
    }

    #[test]
    fn keeps_plausible_geometry_untouched() {
        let healthy = r#"{"main":{"width":1300,"height":650,"x":40,"y":60,"prev_x":0,"prev_y":0,"maximized":false,"visible":true,"decorated":true,"fullscreen":false}}"#;
        assert!(drop_degenerate_entries(healthy).is_none());
    }

    #[test]
    fn drops_only_the_degenerate_entries() {
        let mixed = r#"{"main":{"width":2,"height":2},"other":{"width":800,"height":600}}"#;
        let sanitized = drop_degenerate_entries(mixed).expect("a rewrite");
        assert_eq!(parse(&sanitized).keys().collect::<Vec<_>>(), ["other"]);
    }

    #[test]
    fn the_floor_is_exclusive() {
        assert!(drop_degenerate_entries(r#"{"main":{"width":100,"height":100}}"#).is_none());
        assert!(drop_degenerate_entries(r#"{"main":{"width":99,"height":100}}"#).is_some());
    }

    #[test]
    fn leaves_unrecognized_shapes_for_the_plugin() {
        assert!(drop_degenerate_entries(r#"{"main":{"x":0,"y":0}}"#).is_none());
        assert!(drop_degenerate_entries("not json").is_none());
    }
}
