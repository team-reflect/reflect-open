use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Keyboard<R>> {
    Ok(Keyboard(app.clone()))
}

/// Desktop stand-in: there is no software keyboard, so the state is the
/// permanent zero. Lets shared frontend code subscribe unconditionally.
pub struct Keyboard<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Keyboard<R> {
    pub fn current_height(&self) -> crate::Result<KeyboardState> {
        Ok(KeyboardState::default())
    }

    /// Desktop stand-in: no haptic engine, so a successful no-op.
    pub fn impact_light(&self) -> crate::Result<()> {
        Ok(())
    }
}
