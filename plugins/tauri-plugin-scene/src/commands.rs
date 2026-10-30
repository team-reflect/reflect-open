use tauri::{AppHandle, Runtime, command};

use crate::Result;
use crate::SceneExt;
use crate::models::*;

/// The window's current horizontal size class. Changes arrive on the
/// plugin's `sizeClassChanged` event.
#[command]
pub(crate) async fn size_class<R: Runtime>(app: AppHandle<R>) -> Result<SizeClassPayload> {
    app.scene().size_class()
}
