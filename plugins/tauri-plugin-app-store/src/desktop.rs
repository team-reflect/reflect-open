use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AppStore<R>> {
    Ok(AppStore(app.clone()))
}

/// Desktop stand-in: desktop builds ship outside the App Store (auto-update),
/// so the permanent answer is the fail-closed `Production`.
pub struct AppStore<R: Runtime>(AppHandle<R>);

impl<R: Runtime> AppStore<R> {
    pub fn environment(&self) -> crate::Result<AppStoreEnvironment> {
        Ok(AppStoreEnvironment {
            environment: "Production".into(),
        })
    }
}
