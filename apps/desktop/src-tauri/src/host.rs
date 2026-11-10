//! The [`Host`] that `reflect-core` reaches the Tauri app through.

use reflect_core::Host;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

use crate::error::{AppError, AppResult};

pub struct TauriHost {
    app: AppHandle,
}

impl TauriHost {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl Host for TauriHost {
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
}
