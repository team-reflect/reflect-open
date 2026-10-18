use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_web_auth);

/// Registers the native half. There is no Android implementation yet, so an
/// Android build fails here loudly instead of shipping a sign-in that never opens.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<WebAuth<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-web-auth has no Android implementation yet");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_web_auth)?;
    Ok(WebAuth(handle))
}

/// Access to the system authentication session.
pub struct WebAuth<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> WebAuth<R> {
    /// Show the sign-in page and return the callback URL it redirects to.
    pub fn start(&self, payload: StartRequest) -> crate::Result<StartResponse> {
        self.0
            .run_mobile_plugin("start", payload)
            .map_err(Into::into)
    }
}
