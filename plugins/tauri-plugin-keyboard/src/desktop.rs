use serde::de::DeserializeOwned;
use tauri::{AppHandle, Runtime, plugin::PluginApi};

/// Compiled only by workspace-wide desktop builds; the shipped desktop app never compiles it.
pub fn init<R: Runtime, C: DeserializeOwned>(_app: &AppHandle<R>, _api: PluginApi<R, C>) {}
