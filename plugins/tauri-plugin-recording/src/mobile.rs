use serde::de::DeserializeOwned;
use tauri::{
    plugin::{PluginApi, PluginHandle},
    AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_recording);

/// Registers the native half. Android is a fast-follow like the keyboard
/// plugin (Plan 19 step 12): the Kotlin class does not exist yet, so an
/// Android build fails here loudly instead of shipping a silently
/// non-recording bridge.
pub fn init<R: Runtime, C: DeserializeOwned>(
    _app: &AppHandle<R>,
    api: PluginApi<R, C>,
) -> crate::Result<Recording<R>> {
    #[cfg(target_os = "android")]
    compile_error!("tauri-plugin-recording has no Android implementation yet");
    #[cfg(target_os = "ios")]
    let handle = api.register_ios_plugin(init_plugin_recording)?;
    Ok(Recording(handle))
}

/// Access to the native recorder. Live metering and native-initiated stops
/// arrive on the plugin's `recordingLevel` / `recordingStopped` events.
pub struct Recording<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Recording<R> {
    /// Ask for the microphone (prompting if needed) and start recording into
    /// the staging directory. Resolves once the recorder is live.
    pub fn start_recording(&self, request: StartRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("startRecording", request)
            .map_err(Into::into)
    }

    /// Stop the active recording and return its staged file.
    pub fn stop_recording(&self) -> crate::Result<StopResponse> {
        self.0
            .run_mobile_plugin("stopRecording", ())
            .map_err(Into::into)
    }

    /// Stop the active recording and delete its file.
    pub fn cancel_recording(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("cancelRecording", ())
            .map_err(Into::into)
    }

    /// The webview's action surface is listening — deliver queued actions.
    pub fn actions_ready(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("actionsReady", ())
            .map_err(Into::into)
    }

    /// Retire the delivered action so it doesn't re-fire on the next launch.
    pub fn action_performed(&self) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("actionPerformed", ())
            .map_err(Into::into)
    }

    /// Queue a native action for the webview (see the handshake in
    /// `RecordingPlugin.swift`): persisted until the webview confirms it ran,
    /// so it survives crashes and cold starts. The Rust shell calls this when
    /// a `reflect://record-audio` URL opens the app (the lock-screen widget).
    pub fn queue_action(&self, action: &str) -> crate::Result<()> {
        self.0
            .run_mobile_plugin(
                "queueAction",
                QueueActionRequest {
                    action: action.to_string(),
                },
            )
            .map_err(Into::into)
    }

    /// Whether a native recording is live right now — a fresh webview mount
    /// uses this to stop-and-save a recording that outlived its UI.
    pub fn recording_status(&self) -> crate::Result<RecordingStatusResponse> {
        self.0
            .run_mobile_plugin("recordingStatus", ())
            .map_err(Into::into)
    }

    /// Finished recordings still in staging (crash orphans, files mid-ingest).
    pub fn list_staged(&self) -> crate::Result<ListStagedResponse> {
        self.0
            .run_mobile_plugin("listStaged", ())
            .map_err(Into::into)
    }

    /// A staged file's bytes, base64-encoded.
    pub fn read_staged(&self, request: StagedPathRequest) -> crate::Result<ReadStagedResponse> {
        self.0
            .run_mobile_plugin("readStaged", request)
            .map_err(Into::into)
    }

    /// Remove a staged file — called after its bytes landed in the graph.
    pub fn delete_staged(&self, request: StagedPathRequest) -> crate::Result<()> {
        self.0
            .run_mobile_plugin("deleteStaged", request)
            .map_err(Into::into)
    }
}
