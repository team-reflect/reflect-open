use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<AppStore<R>> {
    Ok(AppStore(app.clone()))
}

/// Compiled only by workspace-wide desktop builds; the shipped desktop app never compiles it.
pub struct AppStore<R: Runtime>(AppHandle<R>);

impl<R: Runtime> AppStore<R> {
    pub fn environment(&self) -> crate::Result<AppStoreEnvironment> {
        Ok(AppStoreEnvironment {
            environment: "Production".into(),
        })
    }

    pub fn sync(&self) -> crate::Result<()> {
        Ok(())
    }

    pub fn present_offer_code_redeem_sheet(&self) -> crate::Result<()> {
        Ok(())
    }
}
