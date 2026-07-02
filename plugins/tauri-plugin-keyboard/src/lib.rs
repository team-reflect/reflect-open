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
use desktop::Keyboard;
#[cfg(mobile)]
use mobile::Keyboard;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the keyboard APIs.
pub trait KeyboardExt<R: Runtime> {
    fn keyboard(&self) -> &Keyboard<R>;
}

impl<R: Runtime, T: Manager<R>> crate::KeyboardExt<R> for T {
    fn keyboard(&self) -> &Keyboard<R> {
        self.state::<Keyboard<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("keyboard")
        .invoke_handler(tauri::generate_handler![
            commands::current_height,
            commands::impact_light
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let keyboard = mobile::init(app, api)?;
            #[cfg(desktop)]
            let keyboard = desktop::init(app, api)?;
            app.manage(keyboard);
            Ok(())
        })
        .build()
}
