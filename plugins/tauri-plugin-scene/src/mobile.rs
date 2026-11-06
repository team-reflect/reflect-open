use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_scene);

/// Registers the native half. Size classes are UIKit's, so an Android build
/// fails here loudly instead of shipping a window that never reports one.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Scene<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-scene has no Android implementation");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_scene)?;
    Ok(Scene(handle))
}

/// Access to the window scene APIs.
pub struct Scene<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Scene<R> {
    /// The window's horizontal size class (`UITraitCollection.horizontalSizeClass`).
    pub fn size_class(&self) -> crate::Result<SizeClassPayload> {
        self.0
            .run_mobile_plugin("sizeClass", ())
            .map_err(Into::into)
    }
}
