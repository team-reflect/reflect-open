use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_native_menu);

/// Registers the native half. These menus are UIKit's, so an Android build
/// fails here loudly instead of shipping commands nobody can choose.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<NativeMenu<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-native-menu has no Android implementation");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_native_menu)?;
    Ok(NativeMenu(handle))
}

/// Access to the native menu APIs.
pub struct NativeMenu<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> NativeMenu<R> {
    /// Rebuild the menu bar (`UIMainMenuSystem`, iPadOS 26+) around `request`.
    /// A no-op before iPadOS 26, which has no menu bar.
    pub fn set_menu(&self, request: SetMenuRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("setMenu", request)
            .map_err(Into::into)
    }

    /// Present a context menu (`UIEditMenuInteraction`) at a point of the
    /// webview; resolves once an item is chosen or the menu is dismissed.
    pub fn present_context_menu(
        &self,
        request: PresentContextMenuRequest,
    ) -> crate::Result<ContextMenuChoice> {
        self.0
            .run_mobile_plugin("presentContextMenu", request)
            .map_err(Into::into)
    }
}
