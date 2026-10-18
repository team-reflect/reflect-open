use tauri::{
    plugin::{Builder, TauriPlugin},
    Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("keyboard")
        .setup(|app, api| {
            #[cfg(mobile)]
            mobile::init(app, api)?;
            #[cfg(desktop)]
            desktop::init(app, api);
            Ok(())
        })
        .build()
}
