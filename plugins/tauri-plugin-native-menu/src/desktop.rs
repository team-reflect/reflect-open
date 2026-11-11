use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<NativeMenu<R>> {
    Ok(NativeMenu(app.clone()))
}

/// Compiled only by workspace-wide desktop builds; the shipped desktop app never compiles it.
pub struct NativeMenu<R: Runtime>(AppHandle<R>);

impl<R: Runtime> NativeMenu<R> {
    pub fn set_menu(&self, _request: SetMenuRequest) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn present_context_menu(
        &self,
        _request: PresentContextMenuRequest,
    ) -> crate::Result<ContextMenuChoice> {
        Err(crate::Error::UnsupportedPlatform)
    }
}
