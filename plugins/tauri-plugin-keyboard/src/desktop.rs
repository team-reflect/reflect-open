use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Keyboard<R>> {
    Ok(Keyboard(app.clone()))
}

/// Compiled only by workspace-wide desktop builds; the shipped desktop app never compiles it.
pub struct Keyboard<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Keyboard<R> {
    pub fn impact_light(&self) -> crate::Result<()> {
        Ok(())
    }
}
