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
