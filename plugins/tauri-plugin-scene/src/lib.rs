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
use desktop::Scene;
#[cfg(mobile)]
use mobile::Scene;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the window scene APIs.
pub trait SceneExt<R: Runtime> {
    fn scene(&self) -> &Scene<R>;
}

impl<R: Runtime, T: Manager<R>> crate::SceneExt<R> for T {
    fn scene(&self) -> &Scene<R> {
        self.state::<Scene<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("scene")
        .invoke_handler(tauri::generate_handler![commands::size_class])
        .setup(|app, api| {
            #[cfg(mobile)]
            let scene = mobile::init(app, api)?;
            #[cfg(desktop)]
            let scene = desktop::init(app, api)?;
            app.manage(scene);
            Ok(())
        })
        .build()
}
