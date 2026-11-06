use tauri::{
    Manager, Runtime,
    plugin::{Builder, TauriPlugin},
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
use desktop::NativeMenu;
#[cfg(mobile)]
use mobile::NativeMenu;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the native menu APIs.
pub trait NativeMenuExt<R: Runtime> {
    fn native_menu(&self) -> &NativeMenu<R>;
}

impl<R: Runtime, T: Manager<R>> crate::NativeMenuExt<R> for T {
    fn native_menu(&self) -> &NativeMenu<R> {
        self.state::<NativeMenu<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("native-menu")
        .invoke_handler(tauri::generate_handler![
            commands::set_menu,
            commands::present_context_menu
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let native_menu = mobile::init(app, api)?;
            #[cfg(desktop)]
            let native_menu = desktop::init(app, api)?;
            app.manage(native_menu);
            Ok(())
        })
        .build()
}
