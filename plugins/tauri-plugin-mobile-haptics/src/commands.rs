use tauri::{command, AppHandle, Runtime};

use crate::HapticsExt;
use crate::Result;

/// Fire a light impact haptic — the app's single haptic strength (date
/// selection, task controls, tab presses). A no-op wherever there is no haptic
/// engine.
#[command]
pub(crate) async fn impact_light<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.haptics().impact_light()
}
