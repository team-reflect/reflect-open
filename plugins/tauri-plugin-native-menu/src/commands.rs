use tauri::{AppHandle, Runtime, command};

use crate::NativeMenuExt;
use crate::Result;
use crate::models::*;

/// Install the app's commands into the iPadOS menu bar, replacing any
/// previous set. Activations arrive on the plugin's `menuCommand` event.
#[command]
pub(crate) async fn set_menu<R: Runtime>(app: AppHandle<R>, request: SetMenuRequest) -> Result<()> {
    app.native_menu().set_menu(request)
}

/// Present a context menu at a point of the webview and resolve with the
/// chosen item, or with no id when the menu was dismissed.
#[command]
pub(crate) async fn present_context_menu<R: Runtime>(
    app: AppHandle<R>,
    request: PresentContextMenuRequest,
) -> Result<ContextMenuChoice> {
    app.native_menu().present_context_menu(request)
}
