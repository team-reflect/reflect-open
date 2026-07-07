use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> crate::Result<Recording<R>> {
    Ok(Recording(app.clone()))
}

/// Desktop stand-in: desktop records through the webview's MediaRecorder
/// (`use-audio-recorder.ts`), so every native-recorder call here is a plain
/// unsupported error — loud, because nothing on desktop should reach it.
pub struct Recording<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Recording<R> {
    pub fn start_recording(&self, _request: StartRequest) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn stop_recording(&self) -> crate::Result<StopResponse> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn cancel_recording(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn actions_ready(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn action_performed(&self) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn queue_action(&self, _action: &str) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn recording_status(&self) -> crate::Result<RecordingStatusResponse> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn list_staged(&self) -> crate::Result<ListStagedResponse> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn read_staged(&self, _request: StagedPathRequest) -> crate::Result<ReadStagedResponse> {
        Err(crate::Error::UnsupportedPlatform)
    }

    pub fn delete_staged(&self, _request: StagedPathRequest) -> crate::Result<()> {
        Err(crate::Error::UnsupportedPlatform)
    }
}
