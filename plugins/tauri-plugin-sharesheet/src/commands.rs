use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Result;
use crate::SharesheetExt;

/// Present the OS share sheet for `payload.text`. Resolves once the sheet has
/// been presented (not when the user picks a target).
#[command]
pub(crate) async fn share<R: Runtime>(app: AppHandle<R>, payload: ShareRequest) -> Result<()> {
    app.sharesheet().share(payload)
}
