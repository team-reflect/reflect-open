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
use desktop::Sharesheet;
#[cfg(mobile)]
use mobile::Sharesheet;

/// Extension on [`tauri::Manager`] types to reach the share-sheet API.
pub trait SharesheetExt<R: Runtime> {
    fn sharesheet(&self) -> &Sharesheet<R>;
}

impl<R: Runtime, T: Manager<R>> crate::SharesheetExt<R> for T {
    fn sharesheet(&self) -> &Sharesheet<R> {
        self.state::<Sharesheet<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("sharesheet")
        .invoke_handler(tauri::generate_handler![commands::share])
        .setup(|app, api| {
            #[cfg(mobile)]
            let sharesheet = mobile::init(app, api)?;
            #[cfg(desktop)]
            let sharesheet = desktop::init(app, api)?;
            app.manage(sharesheet);
            Ok(())
        })
        .build()
}
