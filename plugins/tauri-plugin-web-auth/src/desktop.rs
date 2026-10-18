use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<WebAuth<R>> {
    Ok(WebAuth(app.clone()))
}

/// Compiled only by workspace-wide desktop builds; the shipped desktop app never compiles it.
pub struct WebAuth<R: Runtime>(AppHandle<R>);

impl<R: Runtime> WebAuth<R> {
    pub fn start(&self, _payload: StartRequest) -> crate::Result<StartResponse> {
        Ok(StartResponse { url: None })
    }
}
