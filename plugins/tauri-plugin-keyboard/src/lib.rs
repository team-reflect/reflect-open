use tauri::{
    plugin::{Builder, TauriPlugin},
    Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;

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
