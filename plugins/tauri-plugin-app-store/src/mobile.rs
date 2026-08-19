use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_app_store);

/// Registers the native half. StoreKit has no Android counterpart, so an
/// Android build fails here loudly instead of shipping a probe that always
/// answers `Production`.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<AppStore<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-app-store has no Android implementation");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_app_store)?;
    Ok(AppStore(handle))
}

/// Access to the App Store environment APIs.
pub struct AppStore<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> AppStore<R> {
    /// The channel that installed this build (see `AppStoreEnvironment`).
    pub fn environment(&self) -> crate::Result<AppStoreEnvironment> {
        self.0
            .run_mobile_plugin("getEnvironment", ())
            .map_err(Into::into)
    }
}
