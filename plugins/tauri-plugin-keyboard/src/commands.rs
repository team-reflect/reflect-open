use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::KeyboardExt;
use crate::Result;

/// Mount-time keyboard state for late subscribers; live changes arrive on
/// the plugin's `keyboardChange` event.
#[command]
pub(crate) async fn current_height<R: Runtime>(app: AppHandle<R>) -> Result<KeyboardState> {
    app.keyboard().current_height()
}

/// Fire a light impact haptic — the app's single haptic strength (date
/// selection, task controls, tab presses). A no-op wherever there is no haptic
/// engine.
#[command]
pub(crate) async fn impact_light<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.keyboard().impact_light()
}
