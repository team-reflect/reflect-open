use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Haptics<R>> {
    Ok(Haptics(app.clone()))
}

/// Compiled only by workspace-wide desktop builds; the shipped desktop app never compiles it.
pub struct Haptics<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Haptics<R> {
    pub fn impact_light(&self) -> crate::Result<()> {
        Ok(())
    }
}
