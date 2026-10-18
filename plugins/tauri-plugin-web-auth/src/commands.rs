use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::Result;
use crate::WebAuthExt;

/// Run the system sign-in; see `WebAuth::start`.
#[command]
pub(crate) async fn start<R: Runtime>(
    app: AppHandle<R>,
    payload: StartRequest,
) -> Result<StartResponse> {
    app.web_auth().start(payload)
}
