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
use desktop::Recording;
#[cfg(mobile)]
use mobile::Recording;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to
/// access the recording APIs.
pub trait RecordingExt<R: Runtime> {
    fn recording(&self) -> &Recording<R>;
}

impl<R: Runtime, T: Manager<R>> crate::RecordingExt<R> for T {
    fn recording(&self) -> &Recording<R> {
        self.state::<Recording<R>>().inner()
    }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("recording")
        .invoke_handler(tauri::generate_handler![
            commands::start_recording,
            commands::stop_recording,
            commands::cancel_recording,
            commands::recording_status,
            commands::actions_ready,
            commands::action_performed,
            commands::list_staged,
            commands::read_staged,
            commands::delete_staged,
        ])
        .setup(|app, api| {
            #[cfg(mobile)]
            let recording = mobile::init(app, api)?;
            #[cfg(desktop)]
            let recording = desktop::init(app, api)?;
            app.manage(recording);
            Ok(())
        })
        .build()
}
