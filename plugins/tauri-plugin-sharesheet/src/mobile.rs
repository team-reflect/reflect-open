use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_sharesheet);

/// Registers the native half. Android is a Plan 19 fast-follow: the Kotlin
/// class does not exist yet, so an Android build fails here loudly rather
/// than shipping a silently no-op share action.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Sharesheet<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-sharesheet has no Android implementation yet (Plan 19 step 12)");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_sharesheet)?;
    Ok(Sharesheet(handle))
}

/// Access to the share-sheet API.
pub struct Sharesheet<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Sharesheet<R> {
    /// Present the OS share sheet for the given text.
    pub fn share(&self, payload: ShareRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("share", payload)
            .map_err(Into::into)
    }
}
