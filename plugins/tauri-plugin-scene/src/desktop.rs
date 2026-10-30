use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Scene<R>> {
    Ok(Scene(app.clone()))
}

/// Compiled only by workspace-wide desktop builds; the shipped desktop app never compiles it.
pub struct Scene<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Scene<R> {
    /// A desktop window has room for the desktop workspace at any size.
    pub fn size_class(&self) -> crate::Result<SizeClassPayload> {
        Ok(SizeClassPayload {
            horizontal: HorizontalSizeClass::Regular,
        })
    }
}
