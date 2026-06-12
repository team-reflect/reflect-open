//! Mobile stand-in for the file watcher (Plan 19): there is no watcher on
//! iOS/Android by design — nothing else writes the app sandbox, and local
//! writes notify the frontend in-process (`emitFileChanges`) instead. The
//! commands stay registered so the IPC surface is identical on every
//! platform; starting a watch fails loudly rather than pretending to watch.

use tauri::State;

use crate::error::{AppError, AppResult};

/// Unit stand-in for the desktop watcher state, so `lib.rs` manages the same
/// type name on every platform.
#[derive(Default)]
pub struct WatcherState;

/// Mobile has no watcher: callers must not rely on `index:changed` events
/// from the shell. Fails loudly — the mobile frontend never calls this.
#[tauri::command]
pub fn watch_start(_watcher: State<WatcherState>) -> AppResult<()> {
    Err(AppError::Unknown {
        message: "the file watcher is desktop-only".into(),
    })
}

/// Stopping a watcher that never runs is trivially true — kept `Ok` so shared
/// graph-teardown paths need no platform branches.
#[tauri::command]
pub fn watch_stop(_watcher: State<WatcherState>) -> AppResult<()> {
    Ok(())
}
