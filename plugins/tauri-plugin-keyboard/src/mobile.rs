use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_keyboard);

/// Registers the native half. Android is a Plan 19 fast-follow: the Kotlin
/// class (the scroll-pin equivalent) does not exist yet, so an Android build
/// fails here loudly instead of shipping a silently untuned webview.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Keyboard<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-keyboard has no Android implementation yet (Plan 19 step 12)");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_keyboard)?;
    Ok(Keyboard(handle))
}

/// Access to the keyboard APIs.
pub struct Keyboard<R: Runtime>(PluginHandle<R>);
