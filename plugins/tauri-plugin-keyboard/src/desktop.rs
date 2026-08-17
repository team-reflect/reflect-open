use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Keyboard<R>> {
    Ok(Keyboard(app.clone()))
}

/// Desktop stand-in so shared frontend code can call unconditionally.
pub struct Keyboard<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Keyboard<R> {
    /// Desktop stand-in: no haptic engine, so a successful no-op.
    pub fn impact_light(&self) -> crate::Result<()> {
        Ok(())
    }
}
