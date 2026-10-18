use tauri::{AppHandle, Runtime, command};

use crate::Result;
use crate::WebAuthExt;
use crate::models::*;

/// Run the system sign-in; see `WebAuth::start`.
#[command]
pub(crate) async fn start<R: Runtime>(
    app: AppHandle<R>,
    payload: StartRequest,
) -> Result<StartResponse> {
    app.web_auth().start(payload)
}
