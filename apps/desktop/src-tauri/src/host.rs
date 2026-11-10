//! The [`Host`] that `reflect-core` reaches the Tauri app through.

use reflect_core::Host;
use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};

pub struct TauriHost<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriHost<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> Host for TauriHost<R> {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit(event, payload);
    }

    fn run_on_main(&self, task: Box<dyn FnOnce() + Send>) -> AppResult<()> {
        self.app
            .run_on_main_thread(task)
            .map_err(|err| AppError::io(err.to_string()))
    }

    fn open_url(&self, url: &str) -> AppResult<()> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|err| AppError::io(err.to_string()))
    }

    #[cfg(not(target_os = "ios"))]
    fn reveal_path(&self, path: &std::path::Path) -> AppResult<()> {
        self.app
            .opener()
            .reveal_item_in_dir(path)
            .map_err(|err| AppError::io(err.to_string()))
    }
}
