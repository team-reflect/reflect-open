use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::AppStore;
#[cfg(mobile)]
use mobile::AppStore;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the App Store environment APIs.
pub trait AppStoreExt<R: Runtime> {
    fn app_store(&self) -> &AppStore<R>;
}

impl<R: Runtime, T: Manager<R>> crate::AppStoreExt<R> for T {
    fn app_store(&self) -> &AppStore<R> {
        self.state::<AppStore<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("app-store")
        .invoke_handler(tauri::generate_handler![commands::get_environment])
        .setup(|app, api| {
            #[cfg(mobile)]
            let app_store = mobile::init(app, api)?;
            #[cfg(desktop)]
            let app_store = desktop::init(app, api)?;
            app.manage(app_store);
            Ok(())
        })
        .build()
}
