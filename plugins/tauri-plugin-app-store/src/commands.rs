use tauri::{command, AppHandle, Runtime};

use crate::models::*;
use crate::AppStoreExt;
use crate::Result;

/// Which channel installed this build; see `AppStoreEnvironment`.
#[command]
pub(crate) async fn get_environment<R: Runtime>(app: AppHandle<R>) -> Result<AppStoreEnvironment> {
    app.app_store().environment()
}

/// Force a StoreKit refetch from the App Store; see `AppStore::sync`.
#[command]
pub(crate) async fn sync<R: Runtime>(app: AppHandle<R>) -> Result<()> {
    app.app_store().sync()
}
