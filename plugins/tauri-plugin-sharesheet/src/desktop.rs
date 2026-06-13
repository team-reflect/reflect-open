use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Sharesheet<R>> {
    Ok(Sharesheet(app.clone()))
}

/// Desktop stand-in: the share sheet is an iOS affordance and no desktop
/// surface invokes it. `share` is a no-op so the plugin compiles as a
/// workspace member for the host target.
pub struct Sharesheet<R: Runtime>(#[allow(dead_code)] AppHandle<R>);

impl<R: Runtime> Sharesheet<R> {
    pub fn share(&self, _payload: ShareRequest) -> crate::Result<()> {
        Ok(())
    }
}
